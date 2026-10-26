import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDecisions, evaluateDecisions, evaluationEligibility, exportDecisionSuite, sweepDecisionThresholds } from '../src/application/decision-evaluation.js';
import { decisionEvidenceDigest, policyVersion } from '../src/domain/decision-governance.js';
import { taskId } from '../src/domain/identity.js';
import { governanceFixture } from './governance-helpers.js';

test('fixed decision evaluation binds human routes and optional labels without model calls', async () => {
  const { evaluation, config, calls } = await governanceFixture();
  assert.equal(calls(), 4); assert.equal(evaluation.metrics.total, 4); assert.equal(evaluation.metrics.allowed, 2);
  assert.equal(evaluation.metrics.falseAllow, 0); assert.equal(evaluation.metrics.falseReview, 0);
  assert.equal(evaluation.metrics.kindCorrect, 4); assert.equal(evaluation.metrics.riskCorrect, 4);
  assert.equal(evaluation.metrics.testableCorrect, 4); assert.equal(evaluationEligibility(evaluation, config.decision!).eligible, true);
});

test('threshold replay compares the same dataset and reports false reviews instead of inventing saved calls', async () => {
  const { suite, store, governance, config, evaluation, calls } = await governanceFixture();
  const strict = policyVersion('owner/repo', { name: 'strict', model: 'jev-1.13.0', mode: 'gate', minConfidence: 0.99 });
  const result = await evaluateDecisions(suite, 'owner/repo', config.decision!, strict, store, governance);
  assert.equal(result.metrics.allowed, 0); assert.equal(result.metrics.falseReview, 2); assert.equal(result.metrics.falseReviewRate, 1);
  assert.equal(evaluationEligibility(result, config.decision!).eligible, false);
  const compared = compareDecisions(evaluation, result); assert.equal(compared.changedRoutes.length, 2); assert.equal(calls(), 4);
  assert.equal(result.metrics.tokens, evaluation.metrics.tokens);
});

test('sweep evaluates nine explicit threshold pairs against one frozen human-reviewed suite', async () => {
  const { suite, policy, store, governance, config, calls } = await governanceFixture();
  const sweep = await sweepDecisionThresholds(suite, 'owner/repo', config.decision!, policy, store, governance);
  assert.equal(sweep.providerCalls, 0); assert.equal(sweep.results.length, 9); assert.equal(calls(), 4);
  assert.ok(sweep.results.every(value => value.metrics.total === 4));
});

test('changed decision evidence, foreign reviews and duplicate cases stop offline comparison', async () => {
  const { suite, policy, store, governance, config, records, evaluation } = await governanceFixture();
  const changed = structuredClone(suite); changed.cases[0]!.reviewId = 'f'.repeat(24);
  await assert.rejects(evaluateDecisions(changed, 'owner/repo', config.decision!, policy, store, governance), /evidence changed/);
  await assert.rejects(evaluateDecisions({ ...suite, cases: [suite.cases[0], suite.cases[0]] }, 'owner/repo', config.decision!, policy, store, governance));
  const record = records.find(value => value.id === suite.cases[0]!.decisionId)!;
  record.result!.answers.testable.noul = 0.1; await store.save(record);
  await assert.rejects(evaluateDecisions(suite, 'owner/repo', config.decision!, policy, store, governance), /evidence changed/);
  assert.throws(() => compareDecisions(evaluation, { ...evaluation, datasetDigest: 'f'.repeat(24) }), /same repository/);
});

test('suite export excludes stale labels, preserves earlier human revisions and never infers risk from passing tests', async () => {
  const { store, governance, suite } = await governanceFixture();
  const item = suite.cases[0]!, record = (await store.read(item.decisionId))!, review = (await governance.review(item.reviewId))!;
  await governance.saveReview({ ...review, id: taskId(['new-review', review.id]), labels: { ...review.labels, expectedRoute: 'review' }, createdAt: '2026-10-26T01:00:00Z' });
  const updated = await exportDecisionSuite('owner/repo', 'decision-triage', store, governance);
  assert.notEqual(updated.cases.find(value => value.decisionId === item.decisionId)!.reviewId, item.reviewId);
  assert.equal((await governance.review(item.reviewId))!.labels.expectedRoute, review.labels.expectedRoute);
  record.status = 'error'; record.result = undefined; await store.save(record);
  const remaining = await exportDecisionSuite('owner/repo', 'decision-triage', store, governance);
  assert.equal(remaining.cases.length, 3); assert.notEqual(decisionEvidenceDigest(record), item.evidenceDigest);
});

test('policy promotion needs both route classes, sufficient cases and available evidence', async () => {
  const { evaluation, config } = await governanceFixture();
  for (const metrics of [{ ...evaluation.metrics, total: 1 }, { ...evaluation.metrics, expectedReview: 0 },
    { ...evaluation.metrics, available: 3 }, { ...evaluation.metrics, falseAllow: 1 }])
    assert.equal(evaluationEligibility({ ...evaluation, metrics }, config.decision!).eligible, false);
});

test('offline replay cannot silently compare another Jev model or question rubric', async () => {
  const { evaluation, suite, config, policy, store, governance } = await governanceFixture();
  await assert.rejects(evaluateDecisions(suite, 'other/repo', config.decision!, policy, store, governance), /repository mismatch/);
  const other = policyVersion('owner/repo', { ...policy.spec, model: 'jev-1.14.0' });
  await assert.rejects(evaluateDecisions(suite, 'owner/repo', config.decision!, other, store, governance), /model and question version/);
  assert.equal((await governance.evaluation(evaluation.id))!.id, evaluation.id);
});
