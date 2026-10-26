import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { FileDecisionGovernanceStore } from '../src/adapters/storage/decision-governance-store.js';
import { processDecisionRequests } from '../src/application/decision-requests.js';
import { main } from '../src/cli/bootstrap.js';
import { decisionEvidenceDigest } from '../src/domain/decision-governance.js';
import { taskId } from '../src/domain/identity.js';
import { governanceFixture } from './governance-helpers.js';
import { Store } from '../src/adapters/storage/file-store.js';

test('human review requests work under the controller lock and bind immutable evidence without approving execution', async () => {
  const { config, root, store, governance, records } = await governanceFixture();
  const record = records[0]!, configPath = resolve(root, 'config.json'), reviewPath = resolve(root, 'review.json');
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(reviewPath, JSON.stringify({ expectedRoute: 'review', expectedRisk: 'high', reviewer: 'human', note: 'Requires review.' }));
  const lines: string[] = [], output = { write: (value: string) => lines.push(value), error: (_value: string) => {} };
  const release = await new Store(root).acquire();
  try {
    assert.equal(await main(['decisions', 'review', record.id, '--expected', record.inputDigest, '--spec', reviewPath, '--config', configPath], output), 0);
    assert.equal((await governance.requests(config.repository)).filter(value => !value.receipt).length, 1);
    assert.equal((await store.read(record.id))!.status, 'evaluated');
    assert.equal(await main(['decisions', 'requests', '--config', configPath], output), 0);
  } finally { await release(); }
  const result = await processDecisionRequests(config, store, governance); assert.equal(result[0]!.status, 'applied');
  assert.equal((await governance.reviews(config.repository)).length, 5);
  assert.deepEqual((await store.read(record.id))!.result, record.result);
});

test('changing a decision after inspection rejects its pending manual label', async () => {
  const { config, governance, store, records } = await governanceFixture(); const record = records[0]!;
  await governance.enqueue({ schemaVersion: 1, id: taskId('stale-review'), repository: config.repository,
    createdAt: '2026-10-26T00:00:00Z', action: 'review', decisionId: record.id, inputDigest: record.inputDigest,
    evidenceDigest: decisionEvidenceDigest(record), labels: { expectedRoute: 'review', reviewer: 'human', note: '' } }, 100);
  record.result!.answers.testable.noul = 0.1; await store.save(record);
  assert.equal((await processDecisionRequests(config, store, governance))[0]!.status, 'rejected');
  assert.equal((await governance.reviews(config.repository)).length, 4);
});

test('queued retries preserve attempts and usage, reject exhausted budgets and acknowledge interrupted application once', async () => {
  const { config, governance, store, records } = await governanceFixture(); const record = records[0]!;
  record.status = 'error'; record.result = undefined; record.failure = 'transport'; record.retryable = false; record.attempts = 1;
  await store.save(record); const ledger = await store.ledger(config.repository);
  const request = { schemaVersion: 1 as const, id: taskId('queued-retry'), repository: config.repository, createdAt: '2026-10-26T00:00:00Z',
    action: 'retry' as const, decisionId: record.id, inputDigest: record.inputDigest, recordDigest: taskId(record) };
  await governance.enqueue(request, 100);
  record.operatorRetryId = request.id; record.retryable = true; record.updatedAt = request.createdAt; await store.save(record);
  assert.equal((await processDecisionRequests(config, store, governance))[0]!.status, 'applied');
  assert.equal((await store.read(record.id))!.attempts, 1); assert.deepEqual(await store.ledger(config.repository), ledger);
  record.attempts = config.decision!.maxAttempts; await store.save(record);
  await governance.enqueue({ ...request, id: taskId('exhausted-retry'), recordDigest: taskId(record) }, 100);
  assert.equal((await processDecisionRequests(config, store, governance))[0]!.status, 'rejected');
});

test('governance append deduplicates concurrent writers and never overwrites published policy or review evidence', async () => {
  const { root, governance, policy, records } = await governanceFixture(); const other = new FileDecisionGovernanceStore(root), record = records[0]!;
  const request = { schemaVersion: 1 as const, id: taskId('request-concurrency'), repository: 'owner/repo', createdAt: '2026-10-26T00:00:00Z', action: 'retry' as const,
    decisionId: record.id, inputDigest: record.inputDigest, recordDigest: taskId(record) };
  await Promise.all([governance.enqueue(request, 10), other.enqueue(request, 10)]);
  assert.equal((await governance.requests('owner/repo')).length, 1);
  await assert.rejects(governance.savePolicy({ ...policy, spec: { ...policy.spec, minConfidence: 0.99 } }), /Immutable/);
  await assert.rejects(governance.enqueue({ ...request, inputDigest: 'f'.repeat(24) }, 10), /Immutable/);
  await assert.rejects(governance.enqueue({ ...request, id: taskId('capacity') }, 1), /full/);
  assert.deepEqual(await governance.requests('foreign/repo'), []);
});

test('review receipt recovery preserves the same immutable review revision after an interrupted acknowledgement', async () => {
  const { config, governance, store, records } = await governanceFixture(); const record = records[0]!;
  const request = { schemaVersion: 1 as const, id: taskId('review-crash'), repository: config.repository,
    createdAt: '2026-10-26T00:00:00Z', action: 'review' as const, decisionId: record.id, inputDigest: record.inputDigest,
    evidenceDigest: decisionEvidenceDigest(record), labels: { expectedRoute: 'continue' as const, reviewer: 'human', note: '' } };
  await governance.enqueue(request, 10);
  await governance.saveReview({ schemaVersion: 1, id: taskId(['human-review', request.id]), repository: config.repository,
    decisionId: record.id, inputDigest: record.inputDigest, evidenceDigest: request.evidenceDigest,
    labels: request.labels, createdAt: request.createdAt, requestId: request.id });
  assert.equal((await processDecisionRequests(config, store, governance))[0]!.status, 'applied');
  assert.equal((await governance.reviews(config.repository)).length, 5);
});
