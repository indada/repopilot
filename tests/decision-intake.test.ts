import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { FileDecisionStore } from '../src/adapters/storage/decision-store.js';
import { CandidateDecisionEvaluator } from '../src/application/decisions.js';
import { approveCandidate, evaluateCandidate, processIssueCandidates, refreshCandidates, reproduceCandidate } from '../src/application/candidates.js';
import { processServiceBatch } from '../src/application/service.js';
import { main } from '../src/cli/bootstrap.js';
import { retryDecision } from '../src/cli/commands/decisions.js';
import { decisionSchema, type DecisionConfig } from '../src/domain/decision.js';
import { pollEvent } from '../src/domain/service-events.js';
import { DecisionModelError, type DecisionModel } from '../src/ports/decision.js';
import { decisionResult } from './decision-helpers.js';
import { serviceFixture } from './service-helpers.js';

type Fixture = Awaited<ReturnType<typeof serviceFixture>>;
function enable(d: Fixture['d'], raw: Partial<DecisionConfig>, model: DecisionModel) {
  d.config.decision = decisionSchema.parse({ enabled: true, ...raw });
  const store = new FileDecisionStore(d.config.dataDir);
  d.decision = new CandidateDecisionEvaluator(d.config.repository, d.config.decision, store, model);
  return store;
}

test('disabled decision configuration never calls Jev or changes existing candidate execution', async () => {
  const { d, modelCalls } = await serviceFixture();
  d.decision = { evaluate: async () => { assert.fail('disabled Jev must not run'); } };
  const result = await processIssueCandidates(d);
  assert.equal(result.processed[0]?.status, 'reproduced'); assert.ok(modelCalls() > 0);
});

test('shadow mode records unfavorable Jev advice while preserving stable reproduction and manual approval', async () => {
  const { d, modelCalls } = await serviceFixture();
  const store = enable(d, { mode: 'shadow' }, { evaluate: async () => decisionResult({ risk: 'high' }) });
  const result = await processIssueCandidates(d);
  assert.equal(result.processed[0]?.status, 'reproduced'); assert.ok(modelCalls() > 0);
  const candidate = (await d.candidates.list())[0]!;
  assert.equal(candidate.decision?.route, 'review'); assert.equal((await store.list(d.config.repository)).length, 1);
  assert.equal(result.pendingApproval, 1); assert.deepEqual(await d.goals.list(), []);
});

test('gate mode defers unsafe requests without Codex usage, candidate failure retries or a service circuit failure', async () => {
  const { d, modelCalls } = await serviceFixture({ autoApprove: true });
  enable(d, { mode: 'gate' }, { evaluate: async () => decisionResult({ risk: 'high' }) });
  await d.services.enqueue(pollEvent(d.config.repository, 'decision-gate', 'issue', 7), 1000);
  const result = await processServiceBatch(d, () => {}, error => assert.fail(error));
  const candidate = (await d.candidates.list())[0]!;
  assert.equal(candidate.status, 'observed'); assert.equal(candidate.failureCount, undefined);
  assert.equal(modelCalls(), 0); assert.equal(result.failed, 0); assert.equal((await d.budget.status()).used.tasks, 0);
  assert.equal((await d.budget.status()).failures, 0); assert.deepEqual(await d.goals.list(), []);
});

test('low confidence, vague criteria and a different inferred request type require review instead of changing the trusted intent', async () => {
  const uncertain = decisionResult(); uncertain.answers.risk.confidence = 0.2;
  for (const response of [uncertain, decisionResult({ testable: 0.5 }), decisionResult({ kind: 'feature' })]) {
    const { d, modelCalls } = await serviceFixture({ autoApprove: true });
    enable(d, { mode: 'gate' }, { evaluate: async () => response });
    const result = await processIssueCandidates(d);
    assert.equal(result.deferredByDecision.length, 1); assert.equal(modelCalls(), 0);
    assert.deepEqual(await d.goals.list(), []);
  }
});

test('favorable Jev decisions cannot replace reproduction evidence or grant automatic approval', async () => {
  const { d } = await serviceFixture();
  enable(d, { mode: 'gate' }, { evaluate: async () => decisionResult() });
  await processIssueCandidates(d);
  assert.equal((await d.candidates.list())[0]?.status, 'reproduced'); assert.deepEqual(await d.goals.list(), []);
});

test('revoked authorization is checked before sending Issue content, and changes during evaluation invalidate the result', async () => {
  const { d, issue, modelCalls } = await serviceFixture(); let calls = 0;
  enable(d, { mode: 'gate' }, { evaluate: async () => { calls++; issue.body = 'Changed request while Jev was in progress.'; return decisionResult(); } });
  const candidate = (await refreshCandidates(d, 'issues')).candidates[0]!;
  const labels = issue.labels; issue.labels = [];
  assert.equal((await evaluateCandidate(candidate.id, d)).candidate.status, 'stale'); assert.equal(calls, 0);
  issue.labels = labels; await refreshCandidates(d, 'issues');
  const result = await evaluateCandidate(candidate.id, d);
  assert.equal(result.candidate.status, 'stale'); assert.equal(result.candidate.decision, undefined);
  assert.equal(calls, 1); assert.equal(modelCalls(), 0);
});

test('an explicitly reproduced and approved Issue can recover without a decision granting or revoking that approval', async () => {
  const { d } = await serviceFixture();
  enable(d, { mode: 'gate' }, { evaluate: async () => decisionResult({ risk: 'high' }) });
  await processIssueCandidates(d);
  const candidate = (await d.candidates.list())[0]!;
  await reproduceCandidate(candidate.id, d); await approveCandidate(candidate.id, candidate.evidenceDigest, d);
  d.decision = { evaluate: async () => { assert.fail('approved recovery must not request another admission decision'); } };
  const result = await processIssueCandidates(d);
  assert.equal(result.processed[0]?.status, 'completed'); assert.equal((await d.goals.list()).length, 1);
});

test('a cached review decision cannot starve later eligible candidates under maxPerRun', async () => {
  const { d, issue } = await serviceFixture(); let decisions = 0;
  d.github.issues = async () => [issue, { ...issue, number: 8 }];
  d.github.issue = async number => ({ ...issue, number });
  enable(d, { mode: 'gate' }, { evaluate: async subject => { decisions++; return decisionResult({ risk: subject.issue === 7 ? 'high' : 'low' }); } });
  await processIssueCandidates(d); assert.equal(decisions, 1);
  await processIssueCandidates(d); assert.equal(decisions, 2);
  const candidates = await d.candidates.list();
  assert.equal(candidates.find(candidate => candidate.issue === 7)!.status, 'observed');
  assert.equal(candidates.find(candidate => candidate.issue === 8)!.status, 'reproduced');
});

test('missing Jev credentials defer in gate mode and errors are cached until explicitly retried within existing budgets', async () => {
  const { d, modelCalls } = await serviceFixture(); let requests = 0;
  const store = enable(d, { mode: 'gate' }, { evaluate: async () => { requests++; throw new DecisionModelError('missing_key', false); } });
  await processIssueCandidates(d); await processIssueCandidates(d); assert.equal(requests, 1); assert.equal(modelCalls(), 0);
  const record = (await store.list(d.config.repository))[0]!, output = { write: (_line: string) => {}, error: (_line: string) => {} };
  await assert.rejects(retryDecision(record.id, 'a'.repeat(24), d.config, store, output), /does not match/);
  await retryDecision(record.id, record.inputDigest, d.config, store, output);
  await processIssueCandidates(d); assert.equal(requests, 2);
  assert.equal((await store.list(d.config.repository))[0]!.attempts, 2);
  await retryDecision(record.id, record.inputDigest, d.config, store, output);
  await processIssueCandidates(d); assert.equal(requests, 3);
  await assert.rejects(retryDecision(record.id, record.inputDigest, d.config, store, output), /original attempt allowance/);
});

test('service operator pause reaches active Jev evaluation and retains recoverable unknown usage', async () => {
  const { d, modelCalls } = await serviceFixture();
  const store = enable(d, { mode: 'gate' }, { evaluate: async (_subject, signal) => {
    await d.services.requestControl(d.config.repository, 'pause');
    await new Promise<never>((_resolve, reject) => {
      if (signal!.aborted) reject(signal!.reason);
      else signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
    return decisionResult();
  } });
  await d.services.enqueue(pollEvent(d.config.repository, 'pause-decision', 'issue', 7), 1000);
  await processServiceBatch(d, () => {}, error => assert.fail(error));
  assert.equal((await d.budget.status()).paused, true); assert.equal(modelCalls(), 0);
  assert.equal((await store.list(d.config.repository))[0]!.failure, 'interrupted');
  assert.equal(Object.keys((await store.ledger(d.config.repository))!.reservations).length, 1);
  assert.equal((await d.services.events(d.config.repository))[0]!.receipt!.attempts, 0);
});

test('decision inspection works under the controller lock, validates IDs and enforces repository isolation', async () => {
  const { d, dataDir } = await serviceFixture();
  const store = enable(d, { mode: 'gate' }, { evaluate: async () => decisionResult() });
  const candidate = (await refreshCandidates(d, 'issues')).candidates[0]!; await evaluateCandidate(candidate.id, d);
  const record = (await store.list(d.config.repository))[0]!, configPath = resolve(dataDir, 'config.json');
  await writeFile(configPath, JSON.stringify(d.config));
  const lines: string[] = [], output = { write: (line: string) => lines.push(line), error: (_line: string) => {} };
  const release = await d.store.acquire();
  try {
    for (const args of [['status'], ['list'], ['show', record.id]])
      assert.equal(await main(['decisions', ...args, '--config', configPath], output), 0);
    assert.ok(lines.join('\n').includes('jev-1.13.0'));
    await assert.rejects(main(['decisions', 'show', '../private', '--config', configPath], output), /decision ID/);
    await writeFile(configPath, JSON.stringify({ ...d.config, repository: 'other/repo' }));
    await assert.rejects(main(['decisions', 'show', record.id, '--config', configPath], output), /not found/);
  } finally { await release(); }
});
