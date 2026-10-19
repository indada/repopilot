import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateDecisionEvaluator, decisionBudgetStatus } from '../src/application/decisions.js';
import { JevClient } from '../src/adapters/decision/jev-client.js';
import { decisionIdentity, summarizeDecision } from '../src/domain/decision-policy.js';
import { configSchema } from '../src/domain/config.js';
import { configDigest, pipelineId } from '../src/domain/identity.js';
import { DecisionModelError } from '../src/ports/decision.js';
import { decisionFixture, decisionResult, decisionSubject } from './decision-helpers.js';

const signal = () => new AbortController().signal;

test('concurrent identical decisions reuse one durable result; threshold changes reuse evidence without replenishing budgets', async () => {
  const { evaluator, calls, store, config } = await decisionFixture();
  const results = await Promise.all([evaluator.evaluate(decisionSubject, signal()), evaluator.evaluate(decisionSubject, signal())]);
  assert.equal(calls(), 1); assert.equal(results[0]!.summary.route, 'continue'); assert.equal(results[1]!.attempted, false);
  const record = (await store.list('owner/repo'))[0]!;
  assert.equal(summarizeDecision(record, { ...config, minConfidence: 0.99 }).route, 'review');
  assert.equal((await store.ledger('owner/repo'))!.days[new Date().toISOString().slice(0, 10)]!.tokens, 120);
  assert.deepEqual(await store.list('other/repo'), []); assert.throws(() => store.read('../secret'), /Invalid/);
});

test('unknown usage survives restart and failed decisions respect their original retry allowance and Retry-After', async () => {
  let time = Date.parse('2026-10-19T00:00:00Z'), requests = 0;
  const model = { evaluate: async () => { requests++; throw new DecisionModelError('rate_limited', true, 120000); } };
  const { evaluator, config, store } = await decisionFixture({ maxAttempts: 2 }, model, () => time);
  await evaluator.evaluate(decisionSubject, signal()); time += 61000;
  const resumed = new CandidateDecisionEvaluator('owner/repo', config, store, model, () => time);
  assert.equal((await resumed.evaluate(decisionSubject, signal())).attempted, false); assert.equal(requests, 1);
  time += 61000; await resumed.evaluate(decisionSubject, signal()); time += 86400000;
  await resumed.evaluate(decisionSubject, signal()); assert.equal(requests, 2);
  const ledger = (await store.ledger('owner/repo'))!;
  assert.deepEqual(ledger.days['2026-10-19'], { calls: 2, tokens: config.limits.tokensPerCall * 2 });
  assert.equal(Object.keys(ledger.reservations).length, 2);
});

test('interrupted decision receipts recover conservatively instead of replaying immediately', async () => {
  let time = Date.parse('2026-10-19T12:00:00Z');
  const { store, config, evaluator, calls } = await decisionFixture({}, undefined, () => time);
  const identity = decisionIdentity(decisionSubject, config.model);
  await store.save({ schemaVersion: 1, ...identity, repository: 'owner/repo', candidateId: decisionSubject.candidateId,
    evidenceDigest: decisionSubject.evidenceDigest, intent: 'bugfix', questionVersion: 1, requestedModel: config.model,
    status: 'running', attempts: 1, createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString() });
  const deferred = await evaluator.evaluate(decisionSubject, signal());
  assert.equal(deferred.summary.route, 'review'); assert.equal(calls(), 0);
  time += 61000; await evaluator.evaluate(decisionSubject, signal()); assert.equal(calls(), 1);
  assert.equal((await store.read(identity.id))!.attempts, 2);
});

test('daily decision admission serializes distinct requests and resumes on a new UTC day', async () => {
  let time = Date.parse('2026-10-19T23:59:59Z');
  const { evaluator, calls, config, store } = await decisionFixture({ limits: { dailyCalls: 1 } }, undefined, () => time);
  const second = { ...decisionSubject, issue: 8, candidateId: 'd'.repeat(24) };
  const results = await Promise.all([evaluator.evaluate(decisionSubject, signal()), evaluator.evaluate(second, signal())]);
  assert.equal(calls(), 1); assert.equal(results[1]!.summary.status, 'deferred');
  assert.equal(decisionBudgetStatus(await store.ledger('owner/repo'), config, time).available, false);
  time += 2000; await evaluator.evaluate(second, signal()); assert.equal(calls(), 2);
});

test('late settlement stays on its reserved day and records actual usage above the token reservation', async () => {
  let time = Date.parse('2026-10-19T23:59:59Z');
  const result = decisionResult(); result.usage.input_tokens = 25000;
  const { evaluator, store } = await decisionFixture({}, { evaluate: async () => { time += 2000; return result; } }, () => time);
  await evaluator.evaluate(decisionSubject, signal());
  const ledger = (await store.ledger('owner/repo'))!;
  assert.equal(ledger.days['2026-10-19']!.tokens, 25020); assert.equal(Object.keys(ledger.reservations).length, 0);
});

test('failed durable settlement never becomes a successful shadow-mode fallback', async () => {
  const { config, store } = await decisionFixture(); let writes = 0;
  const original = store.saveLedger.bind(store);
  store.saveLedger = async ledger => { if (++writes === 2) throw new Error('synthetic disk failure'); await original(ledger); };
  const evaluator = new CandidateDecisionEvaluator('owner/repo', config, store, { evaluate: async () => decisionResult() });
  await assert.rejects(evaluator.evaluate(decisionSubject, signal()), /disk failure/);
  assert.equal((await store.list('owner/repo'))[0]!.status, 'running');
  assert.equal(Object.keys((await store.ledger('owner/repo'))!.reservations).length, 1);
});

test('optional admission-only Jev settings preserve existing task and goal configuration identity', () => {
  const config = configSchema.parse({ repository: 'owner/repo' });
  const enabled = configSchema.parse({ ...config, decision: { enabled: true, mode: 'gate' } });
  const input = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
  assert.equal(configDigest(config), configDigest(enabled)); assert.equal(pipelineId(input, config), pipelineId(input, enabled));
  assert.throws(() => configSchema.parse({ ...config, decision: { model: 'jev-latest' } }));
  assert.throws(() => configSchema.parse({ ...config, decision: { baseUrl: 'https://attacker.invalid' } }));
  assert.throws(() => configSchema.parse({ ...config, decision: { limits: { dailyTokens: 1000, tokensPerCall: 2000 } } }));
});

test('local credential preflight failures retain an inspectable record without spending a remote-call allowance', async () => {
  const { config, store } = await decisionFixture(); let requests = 0;
  const client = new JevClient(config, undefined, async () => { requests++; return Response.json(decisionResult()); });
  const evaluator = new CandidateDecisionEvaluator('owner/repo', config, store, client);
  const result = await evaluator.evaluate(decisionSubject, signal());
  assert.equal(result.summary.route, 'review'); assert.equal(result.attempted, false); assert.equal(requests, 0);
  assert.equal((await store.list('owner/repo'))[0]!.failure, 'missing_key');
  assert.equal((await store.list('owner/repo'))[0]!.attempts, 0); assert.equal(await store.ledger('owner/repo'), undefined);
});

test('changing an operational decision allowance unblocks admission without discarding the prior ledger', async () => {
  const { evaluator, config, store, calls } = await decisionFixture({ limits: { dailyCalls: 1 } });
  const second = { ...decisionSubject, issue: 8 };
  await evaluator.evaluate(decisionSubject, signal()); await evaluator.evaluate(second, signal());
  config.limits.dailyCalls = 2; await evaluator.evaluate(second, signal());
  assert.equal(calls(), 2); assert.equal(decisionBudgetStatus(await store.ledger('owner/repo'), config).used.calls, 2);
});

test('a decision for changed input cannot reuse the earlier evidence record', async () => {
  const { evaluator, calls, store } = await decisionFixture();
  const first = await evaluator.evaluate(decisionSubject, signal());
  const next = await evaluator.evaluate({ ...decisionSubject, request: 'New acceptance behavior.', evidenceDigest: 'e'.repeat(24) }, signal());
  assert.notEqual(first.summary.id, next.summary.id); assert.equal(calls(), 2);
  assert.equal((await store.list('owner/repo')).length, 2);
});
