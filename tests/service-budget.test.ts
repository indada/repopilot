import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { FileServiceStore } from '../src/adapters/storage/service-store.js';
import { CodexAgentTeam } from '../src/adapters/codex/team.js';
import { DockerCodexAgent } from '../src/adapters/codex/docker-agent.js';
import { ServiceBudget } from '../src/application/service-budget.js';
import { configSchema } from '../src/domain/config.js';
import { configDigest, pipelineId } from '../src/domain/identity.js';
import { serviceSchema } from '../src/domain/service.js';
import { AutomationPausedError } from '../src/shared/control.js';

async function store() {
  await mkdir('.cache/tests', { recursive: true });
  return new FileServiceStore(await mkdtemp(resolve('.cache/tests/service-budget-')));
}
test('parallel model reservations cannot exceed the daily allowance and unknown usage survives restart', async () => {
  const data = await store(), config = serviceSchema.parse({ limits: { dailyCalls: 2, dailyTokens: 200 } });
  const budget = new ServiceBudget(data, 'owner/repo', config, 100);
  const results = await Promise.allSettled([budget.reserve(), budget.reserve(), budget.reserve()]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  const first = results[0]!; assert.equal(first.status, 'fulfilled');
  if (first.status === 'fulfilled') await first.value.settle(30);
  const resumed = new ServiceBudget(data, 'owner/repo', config, 100);
  assert.deepEqual((await resumed.status()).used, { calls: 2, tokens: 130, tasks: 0 });
  assert.equal((await resumed.status()).unknownCalls, 1);
  await assert.rejects(resumed.reserve(), AutomationPausedError);
});
test('midnight accounting charges a late settlement to its original day and retains over-limit actual usage', async () => {
  const data = await store(), config = serviceSchema.parse({ limits: { dailyTokens: 100 } });
  let time = Date.parse('2026-10-08T23:59:59Z');
  const budget = new ServiceBudget(data, 'owner/repo', config, 100, () => time);
  const call = await budget.reserve();
  time += 2000; await call.settle(150);
  const ledger = (await data.ledger('owner/repo'))!;
  assert.equal(ledger.days['2026-10-08']?.tokens, 150);
  assert.equal((await budget.status()).used.tokens, 0);
  const next = await budget.reserve(); await next.settle(150);
  await assert.rejects(budget.reserve(), /token limit/);
  assert.equal((await budget.status()).used.tokens, 150);
});
test('operator resume clears the circuit while preserving consumed daily task and model allowances', async () => {
  const data = await store(), config = serviceSchema.parse({ limits: { dailyTasks: 1, failureThreshold: 2 } });
  const budget = new ServiceBudget(data, 'owner/repo', config, 100);
  await budget.startTask(); const call = await budget.reserve(); await call.settle(12);
  await budget.outcome('failure'); await budget.outcome('failure');
  assert.ok((await budget.status()).reasons.some(reason => reason.includes('circuit')));
  await data.requestControl('owner/repo', 'pause');
  await assert.rejects(budget.reserve(), /operator/);
  await data.requestControl('owner/repo', 'resume');
  const status = await budget.status();
  assert.equal(status.failures, 0); assert.deepEqual(status.used, { calls: 1, tokens: 12, tasks: 1 });
  await assert.rejects(budget.startTask(), /task limit/);
  // An already-admitted task can finish within the remaining call/token allowance.
  const continuing = await budget.reserve(); await continuing.settle(8);
  assert.equal((await budget.status()).used.calls, 2);
});
test('service operational settings do not invalidate pinned execution evidence', () => {
  const original = configSchema.parse({ repository: 'owner/repo' });
  const service = configSchema.parse({ ...original, service: { progress: true } });
  const input = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), description: 'validation' };
  assert.equal(configDigest(original), configDigest(service));
  assert.equal(pipelineId(input, original), pipelineId(input, service));
  assert.notEqual(configDigest(service), configDigest({ ...service, publish: true }));
});

test('Codex role agents and execution forks all consult the shared guard before starting a container', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/model-guard-'));
  const config = configSchema.parse({ repository: 'owner/repo', agent: { enabled: true, image: 'repopilot-test-no-execution:invalid' },
    iteration: { collaboration: {} } });
  let reservations = 0;
  const guard = { reserve: async () => { reservations++; throw new AutomationPausedError('synthetic policy denial'); } };
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-placeholder';
  try {
    const snapshot = new Map([['src/a.ts', 'export const value = 1;']]);
    const single = new DockerCodexAgent(config.agent, root, undefined, undefined, undefined, guard);
    const team = new CodexAgentTeam(config.agent, config.iteration!.collaboration, root, undefined, guard);
    await assert.rejects(single.forkExecution().review(snapshot, snapshot, 'guard validation'), AutomationPausedError);
    await assert.rejects(team.forRole('tester').plan(snapshot, snapshot, 'guard validation'), AutomationPausedError);
    await assert.rejects(team.forkExecution().forRole!('developer').repair(snapshot, snapshot, 'guard validation'), AutomationPausedError);
    assert.equal(reservations, 3);
  } finally { if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; }
});
