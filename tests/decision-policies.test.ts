import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPolicyTransition, configuredPolicyVersion, effectiveDecisionConfig, policyPreview } from '../src/application/decision-policies.js';
import { processDecisionRequests } from '../src/application/decision-requests.js';
import { CandidateDecisionEvaluator } from '../src/application/decisions.js';
import { taskId } from '../src/domain/identity.js';
import { decisionSubject, decisionResult } from './decision-helpers.js';
import { governanceFixture } from './governance-helpers.js';

test('explicit evaluated activation and rollback preserve original evidence, daily usage and transition history', async () => {
  const { config, governance, store, policy, evaluation } = await governanceFixture();
  const ledger = await store.ledger('owner/repo');
  const preview = await policyPreview('owner/repo', config.decision!, governance, 'activate', policy.id, evaluation.id, store);
  assert.equal(preview.eligible, true);
  const requestId = taskId('activate-once');
  await applyPolicyTransition('owner/repo', config.decision!, governance, requestId, '2026-10-26T00:00:00Z', 'activate', preview.token, policy.id, evaluation.id, store);
  await applyPolicyTransition('owner/repo', config.decision!, governance, requestId, '2026-10-26T00:00:00Z', 'activate', preview.token, policy.id, evaluation.id, store);
  assert.equal((await governance.policyState('owner/repo'))!.revision, 1);
  assert.equal((await effectiveDecisionConfig('owner/repo', config.decision!, governance)).mode, 'gate');
  const rollback = await policyPreview('owner/repo', config.decision!, governance, 'rollback');
  assert.equal(rollback.target, configuredPolicyVersion('owner/repo', config.decision!).id);
  await applyPolicyTransition('owner/repo', config.decision!, governance, taskId('rollback'), '2026-10-26T01:00:00Z', 'rollback', rollback.token);
  assert.equal((await governance.policyState('owner/repo'))!.active, rollback.target);
  assert.equal((await governance.policyState('owner/repo'))!.history.length, 2); assert.deepEqual(await store.ledger('owner/repo'), ledger);
});

test('first activation snapshots the configured baseline so rollback preserves its original thresholds', async () => {
  const { config, governance, store, policy, evaluation } = await governanceFixture();
  config.decision!.minConfidence = 0.75;
  const preview = await policyPreview('owner/repo', config.decision!, governance, 'activate', policy.id, evaluation.id, store);
  await applyPolicyTransition('owner/repo', config.decision!, governance, taskId('baseline-snapshot'), '', 'activate', preview.token, policy.id, evaluation.id, store);
  config.decision!.minConfidence = 0.99;
  const rollback = await policyPreview('owner/repo', config.decision!, governance, 'rollback');
  await applyPolicyTransition('owner/repo', config.decision!, governance, taskId('restore-snapshot'), '', 'rollback', rollback.token);
  assert.equal((await effectiveDecisionConfig('owner/repo', config.decision!, governance)).minConfidence, 0.75);
});

test('stale preview, missing evaluation, foreign policy and disabled managed mode cannot activate', async () => {
  const { config, governance, policy, evaluation, store } = await governanceFixture();
  const valid = await policyPreview('owner/repo', config.decision!, governance, 'activate', policy.id, evaluation.id, store);
  await assert.rejects(applyPolicyTransition('owner/repo', config.decision!, governance, taskId('bad'), '', 'activate', 'a'.repeat(24), policy.id, evaluation.id), /preview changed/);
  assert.equal((await policyPreview('owner/repo', config.decision!, governance, 'activate', policy.id)).eligible, false);
  assert.equal((await policyPreview('foreign/repo', config.decision!, governance, 'activate', policy.id, evaluation.id)).eligible, false);
  assert.equal((await policyPreview('owner/repo', { ...config.decision!, useManagedPolicy: false }, governance, 'activate', policy.id, evaluation.id)).eligible, false);
  await applyPolicyTransition('owner/repo', config.decision!, governance, taskId('good'), '', 'activate', valid.token, policy.id, evaluation.id, store);
  await assert.rejects(applyPolicyTransition('owner/repo', config.decision!, governance, taskId('old'), '', 'activate', valid.token, policy.id, evaluation.id), /preview changed/);
});

test('operator policy request resumes idempotently after a crash between state and receipt writes', async () => {
  const { config, governance, store, policy, evaluation } = await governanceFixture();
  const preview = await policyPreview('owner/repo', config.decision!, governance, 'activate', policy.id, evaluation.id, store);
  const request = { schemaVersion: 1 as const, id: taskId('queued-policy'), repository: 'owner/repo', createdAt: '2026-10-26T00:00:00Z',
    action: 'activate' as const, policyId: policy.id, evaluationId: evaluation.id, expected: preview.token };
  await governance.enqueue(request, 10);
  await applyPolicyTransition('owner/repo', config.decision!, governance, request.id, request.createdAt, 'activate', preview.token, policy.id, evaluation.id, store);
  assert.equal((await processDecisionRequests(config, store, governance))[0]!.status, 'applied');
  assert.equal((await governance.policyState('owner/repo'))!.revision, 1);
  assert.equal((await governance.requests('owner/repo'))[0]!.receipt!.status, 'applied');
});

test('one evaluation freezes its policy before a concurrent activation changes future recommendations', async () => {
  const { config, governance, store } = await governanceFixture();
  let threshold = 0.85;
  const evaluator = new CandidateDecisionEvaluator('owner/repo', config.decision!, store, { evaluate: async () => {
    threshold = 0.99; return decisionResult();
  } }, Date.now, async () => ({ ...config.decision!, minConfidence: threshold }));
  const first = await evaluator.evaluate(decisionSubject, new AbortController().signal);
  const next = await evaluator.evaluate(decisionSubject, new AbortController().signal);
  assert.equal(first.summary.route, 'continue'); assert.equal(next.summary.route, 'review'); assert.equal(next.attempted, false);
  assert.notEqual(first.summary.policyDigest, next.summary.policyDigest);
  assert.equal((await governance.policyState('owner/repo'))?.revision, undefined);
});

test('a changed fixed-case result invalidates an earlier promotion preview before any policy state write', async () => {
  const { config, governance, store, records, policy, evaluation } = await governanceFixture();
  const preview = await policyPreview('owner/repo', config.decision!, governance, 'activate', policy.id, evaluation.id, store);
  const record = records[0]!; record.result!.answers.testable.noul = 0.1; await store.save(record);
  const changed = await policyPreview('owner/repo', config.decision!, governance, 'activate', policy.id, evaluation.id, store);
  assert.equal(changed.eligible, false); assert.notEqual(changed.token, preview.token);
  await assert.rejects(applyPolicyTransition('owner/repo', config.decision!, governance, taskId('changed-evidence'), '', 'activate', preview.token, policy.id, evaluation.id, store), /preview changed/);
  assert.equal(await governance.policyState('owner/repo'), undefined);
});
