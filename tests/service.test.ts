import assert from 'node:assert/strict';
import test from 'node:test';
import { FileServiceStore } from '../src/adapters/storage/service-store.js';
import { processServiceBatch, runService } from '../src/application/service.js';
import { ServiceBudget } from '../src/application/service-budget.js';
import { pollEvent } from '../src/domain/service-events.js';
import { pipelineId } from '../src/domain/identity.js';
import { pr, verifiedReport } from './helpers.js';
import { inspectService } from '../src/cli/commands/service.js';
import { serviceFixture } from './service-helpers.js';

const output = { write: (_line: string) => {}, error: (line: string) => assert.fail(line) };
const process = (d: Awaited<ReturnType<typeof serviceFixture>>['d']) => processServiceBatch(d, () => {}, output.error);
test('poll compensation discovers an Issue, reproduces it and accepts approval while the controller lock is held', async () => {
  const { d, dataDir, feedback, modelCalls } = await serviceFixture({ service: { progress: true } });
  const release = await d.store.acquire();
  try {
    assert.equal(await runService(d, true, () => {}, output.error), 0);
    const candidate = (await d.candidates.list())[0]!;
    assert.equal(candidate.status, 'reproduced'); assert.deepEqual(await d.goals.list(), []);
    assert.match(feedback.get(7)!.body, /awaiting execution approval/);
    const firstCalls = modelCalls();
    assert.ok(await inspectService('service', 'approve', candidate.id, { expected: candidate.evidenceDigest }, d.config,
      new FileServiceStore(dataDir), d.candidates, output));
    await process(d);
    assert.equal((await d.candidates.read(candidate.id))?.status, 'completed');
    assert.equal((await d.goals.list()).length, 1); assert.ok(modelCalls() > firstCalls);
    assert.equal((await d.budget.status()).used.tasks, 2);
  } finally { await release(); }
});
test('duplicate and out-of-order Issue hints coalesce and use current API inputs', async () => {
  const { d, issue, modelCalls, publications } = await serviceFixture({ autoApprove: true, publish: true });
  for (const delivery of ['newer', 'older', 'repeated']) await d.services.enqueue(pollEvent(d.config.repository, delivery, 'issue', 7), 1000);
  issue.body = 'Negative quantities must be rejected before saving the order.';
  const values: any[] = [];
  await processServiceBatch(d, value => values.push(value), output.error);
  assert.equal(values[0].deliveries, 3); assert.equal((await d.goals.list())[0]?.spec.objective, issue.title + '\n' + issue.body);
  assert.equal(publications(), 1);
  const calls = modelCalls();
  // Recover an interrupted acknowledgement after all verification/publication has already completed.
  const event = (await d.services.events(d.config.repository))[0]!.event;
  await d.services.receipt(event.id, { status: 'processing', attempts: 1, updatedAt: new Date().toISOString() });
  await process({ ...d, services: new FileServiceStore(d.config.dataDir),
    budget: new ServiceBudget(d.services, d.config.repository, d.config.service!, d.config.agent.maxTokens) });
  assert.equal(modelCalls(), calls); assert.equal(publications(), 1);
  assert.equal((await d.goals.list()).length, 1); assert.equal((await d.budget.status()).used.tasks, 1);
});
test('revoked labels and stale queued approvals cannot authorize execution', async () => {
  const { d, issue, modelCalls } = await serviceFixture();
  await runService(d, true, () => {}, output.error);
  const candidate = (await d.candidates.list())[0]!;
  await inspectService('service', 'approve', candidate.id, { expected: candidate.evidenceDigest }, d.config, d.services, d.candidates, output);
  issue.labels = []; const calls = modelCalls(), errors: string[] = [];
  const result = await processServiceBatch(d, () => {}, error => errors.push(error));
  assert.equal(result.failed, 0); assert.deepEqual(errors, []);
  assert.equal((await d.budget.status()).failures, 0);
  assert.ok((await d.services.events(d.config.repository)).some(item => item.receipt?.reason?.includes('approval rejected')));
  assert.equal(modelCalls(), calls); assert.deepEqual(await d.goals.list(), []);
});
test('daily model allowance defers candidates without marking reproduction or consuming candidate failure retries', async () => {
  const { d } = await serviceFixture({ autoApprove: true, service: { limits: { dailyCalls: 1 } } });
  await d.services.enqueue(pollEvent(d.config.repository, 'budget-stop', 'issue', 7), 1000);
  const result = await process(d);
  assert.equal(result.failed, 0);
  const candidate = (await d.candidates.list())[0]!;
  assert.equal(candidate.status, 'observed'); assert.equal(candidate.failureCount, undefined);
  assert.equal(candidate.reproduction, undefined); assert.deepEqual(await d.goals.list(), []);
  const event = (await d.services.events(d.config.repository))[0]!;
  assert.equal(event.receipt?.status, 'pending'); assert.equal(event.receipt?.attempts, 0);
  assert.equal((await d.budget.status()).used.calls, 1);
  // Raising only the operational daily limit preserves the same candidate/report identity.
  d.config.service!.limits.dailyCalls = 200;
  for (const report of await d.store.list()) if (report.servicePause) { report.retryAfter = new Date(0).toISOString(); await d.store.save(report); }
  await d.services.receipt(event.event.id, { ...event.receipt!, retryAfter: new Date(0).toISOString() });
  await process(d);
  assert.equal((await d.candidates.list())[0]?.status, 'completed');
  assert.equal((await d.goals.list()).length, 1);
  assert.ok((await d.budget.status()).used.calls > 1);
});
test('service pause interrupts active reproduction and resume preserves its evidence and budget', async () => {
  const { d } = await serviceFixture();
  const runner = d.runner!; let requested = false;
  d.runner = { run: async (files, phase, signal) => {
    if (phase === 'planned-head' && !requested) {
      requested = true; await d.services.requestControl(d.config.repository, 'pause');
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(resolve, 2000);
      });
    }
    return runner.run(files, phase, signal);
  } };
  await d.services.enqueue(pollEvent(d.config.repository, 'paused-work', 'issue', 7), 1000);
  await process(d);
  assert.equal((await d.budget.status()).paused, true);
  assert.equal((await d.candidates.list())[0]?.reproduction, undefined);
  await d.services.requestControl(d.config.repository, 'resume');
  const item = (await d.services.events(d.config.repository))[0]!;
  await d.services.receipt(item.event.id, { ...item.receipt!, retryAfter: new Date(0).toISOString() });
  await process(d);
  assert.equal((await d.candidates.list())[0]?.status, 'reproduced');
  assert.equal((await d.budget.status()).used.tasks, 2);
});
test('infrastructure failures persist exponential retry state, trip the circuit and recover only on explicit resume', async () => {
  const { d } = await serviceFixture({ service: { limits: { failureThreshold: 1 }, queue: { maxAttempts: 1 } } });
  d.repository.fetch = async () => { throw new Error('synthetic fetch outage'); };
  const event = pollEvent(d.config.repository, 'fault', 'issue', 7);
  await d.services.enqueue(event, 1000);
  const messages: string[] = [];
  assert.equal((await processServiceBatch(d, () => {}, line => messages.push(line))).failed, 1);
  assert.equal((await d.services.events(d.config.repository))[0]?.receipt?.status, 'dead');
  assert.ok((await d.budget.status()).reasons.some(reason => reason.includes('circuit')));
  await inspectService('service', 'resume', undefined, {}, d.config, d.services, d.candidates, output);
  await inspectService('events', 'retry', event.id, {}, d.config, d.services, d.candidates, output);
  assert.equal((await d.budget.status()).failures, 0);
  assert.equal((await d.budget.status()).used.tasks, 1);
  assert.equal((await d.services.events(d.config.repository)).filter(item => !item.receipt).length, 1);
});

test('hints arriving during execution remain queued and do not replay completed publication', async () => {
  const { d, publications, modelCalls } = await serviceFixture({ autoApprove: true, publish: true });
  let appended = false;
  const original = d.agent!.repair;
  d.agent!.repair = async (...args) => {
    if (!appended) { appended = true; await d.services.enqueue(pollEvent(d.config.repository, 'during-work', 'issue', 7), 1000); }
    return original(...args);
  };
  await d.services.enqueue(pollEvent(d.config.repository, 'initial-work', 'issue', 7), 1000);
  await process(d); const calls = modelCalls();
  assert.equal((await d.services.events(d.config.repository)).filter(item => !item.receipt).length, 1);
  await process(d); assert.equal(modelCalls(), calls); assert.equal(publications(), 1);
});

test('waiting checks, oversized feedback and normal PR closure spend no new task or failure allowance', async () => {
  const { d, modelCalls } = await serviceFixture({ autoApprove: true, publish: true });
  d.config.iteration!.maintenance = { trustedReviewers: ['maintainer'], requiredChecks: ['tests'] };
  await d.services.enqueue(pollEvent(d.config.repository, 'issue', 'issue', 7), 1000);
  await process(d);
  const goal = (await d.goals.list())[0]!, calls = modelCalls();
  const pull = { ...pr, number: 10, head: { ...pr.head, ref: `autofix/goal-${goal.id}/${goal.publication}` } };
  d.github.pull = async () => pull;
  d.github.feedback = async () => ({ pr: pull, headRun: goal.publication, comments: [],
    checks: [{ name: 'tests', status: 'in_progress', conclusion: null }] });
  await d.services.enqueue(pollEvent(d.config.repository, 'check-pending', 'pull', 10), 1000);
  await process(d);
  assert.equal((await d.budget.status()).used.tasks, 1); assert.equal(modelCalls(), calls);
  d.github.feedback = async () => ({ pr: pull, headRun: goal.publication,
    comments: Array.from({ length: 21 }, (_, id) => ({ id: String(id), author: 'maintainer', body: 'Add a new acceptance requirement.' })),
    checks: [{ name: 'tests', status: 'completed', conclusion: 'success' }] });
  await d.services.enqueue(pollEvent(d.config.repository, 'bounded-feedback', 'pull', 10), 1000);
  await process(d);
  assert.equal((await d.budget.status()).used.tasks, 1); assert.equal((await d.budget.status()).failures, 0);
  assert.equal(modelCalls(), calls);
  pull.state = 'closed';
  await d.services.enqueue(pollEvent(d.config.repository, 'closed', 'pull', 10), 1000);
  await process(d); assert.equal((await d.budget.status()).failures, 0);
});

test('repeated post-merge hints count a regression transition once without repeating task admission', async () => {
  const { d, modelCalls } = await serviceFixture({ autoApprove: true, publish: true });
  d.config.iteration!.postMerge = { requiredChecks: ['tests'], requireIssueClosed: false };
  await d.services.enqueue(pollEvent(d.config.repository, 'source-issue', 'issue', 7), 1000);
  await process(d);
  const goal = (await d.goals.list())[0]!, calls = modelCalls();
  const pull = { ...pr, number: 10, state: 'closed' as const, merged_at: '2026-10-08T00:00:00Z', merge_commit_sha: 'c'.repeat(40),
    head: { ...pr.head, ref: `autofix/goal-${goal.id}/${goal.publication}` } };
  d.github.outcome = async () => ({ pr: pull, checks: [{ name: 'tests', status: 'completed', conclusion: 'failure' }] });
  for (const delivery of ['merged-one', 'merged-two']) {
    await d.services.enqueue(pollEvent(d.config.repository, delivery, 'pull', 10), 1000);
    await processServiceBatch(d, () => {}, output.error);
  }
  assert.equal((await d.goals.read(goal.id))?.postMerge?.status, 'regressed');
  assert.equal((await d.budget.status()).failures, 1); assert.equal((await d.budget.status()).used.tasks, 1);
  assert.equal(modelCalls(), calls);
});

test('cached terminal PR findings cannot spend fresh task budget or repeatedly trip the circuit', async () => {
  const { d, modelCalls } = await serviceFixture({ service: { reviewPullRequests: true, limits: { failureThreshold: 1 } } });
  const pull = { ...pr, base: { ...pr.base, sha: 'a'.repeat(40) }, head: { ...pr.head, sha: 'a'.repeat(40) } };
  d.github.pull = async () => pull;
  const report = { ...verifiedReport(), id: pipelineId({ baseSha: pull.base.sha, headSha: pull.head.sha, pr: pull }, d.config), status: 'needs_attention' as const };
  await d.store.save(report);
  for (const delivery of ['duplicate-one', 'duplicate-two']) {
    await d.services.enqueue(pollEvent(d.config.repository, delivery, 'pull', 1), 1000); await process(d);
  }
  assert.equal(modelCalls(), 0); assert.equal((await d.budget.status()).used.tasks, 0);
  assert.equal((await d.budget.status()).failures, 0);
});
