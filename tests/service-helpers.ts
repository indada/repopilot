import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileCandidateStore } from '../src/adapters/storage/candidate-store.js';
import { Store } from '../src/adapters/storage/file-store.js';
import { FileIterationStore } from '../src/adapters/storage/iteration-store.js';
import { FileServiceStore } from '../src/adapters/storage/service-store.js';
import { ServiceBudget } from '../src/application/service-budget.js';
import type { ServiceDependencies } from '../src/application/service.js';
import { configSchema } from '../src/domain/config.js';
import type { Answer } from '../src/domain/agent-answer.js';
import type { QueueIssue } from '../src/ports/automation.js';
import { answer, result, testCase } from './helpers.js';

export async function serviceFixture(options: { autoApprove?: boolean; service?: Record<string, unknown>; publish?: boolean } = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const dataDir = await mkdtemp(resolve('.cache/tests/service-'));
  const config = configSchema.parse({ repository: 'owner/repo', dataDir, publish: options.publish ?? false,
    agent: { enabled: true, repair: true }, service: options.service ?? {},
    iteration: { queue: { labels: ['agent-ready'], trustedAuthors: ['maintainer'], allowedPaths: ['src', 'test'], autoApprove: options.autoApprove ?? false } } });
  const issue: QueueIssue = { number: 7, title: 'Reject negative quantities', body: 'Negative quantities must produce a validation error.',
    state: 'open', user: { login: 'maintainer' }, labels: [{ name: 'agent-ready' }], created_at: '2026-01-01T00:00:00Z' };
  const sha = 'a'.repeat(40), snapshot = new Map([['src/a.ts', 'BROKEN']]);
  const services = new FileServiceStore(dataDir), budget = new ServiceBudget(services, config.repository, config.service!, config.agent.maxTokens);
  let calls = 0, tokens = 0, modelCalls = 0, publications = 0;
  const invoke = async (operation: () => Answer) => {
    const reserved = await budget.reserve(); calls++; tokens += 10; modelCalls++;
    try { return operation(); } finally { await reserved.settle(10); }
  };
  const feedback = new Map<number, { marker: string; body: string }>();
  const d: ServiceDependencies = { config, services, budget, store: new Store(dataDir), goals: new FileIterationStore(dataDir),
    candidates: new FileCandidateStore(dataDir), signal: new AbortController().signal,
    github: { issues: async () => issue.state === 'open' ? [issue] : [], issue: async () => issue,
      target: async () => ({ branch: 'main', sha }), listPulls: async () => [], pull: async () => { throw new Error('Unexpected PR read'); },
      current: async report => report.goal ? issue : undefined,
      publish: async () => { publications++; return 'https://github.com/owner/repo/pull/10'; },
      feedback: async () => { throw new Error('Unexpected feedback'); }, updatePull: async () => undefined,
      recoverPull: async () => undefined, propose: async () => '', outcome: async () => { throw new Error('Unexpected outcome'); },
      syncProgress: async (number, marker, body) => { feedback.set(number, { marker, body }); return number * 10; } },
    repository: { prepare: async () => {}, fetch: async (_path, _repo, from, to) => { assert.equal(from, sha); assert.equal(to, sha); },
      snapshot: async () => snapshot, resolveCommit: async () => sha },
    runner: { run: async files => {
      const cases = [testCase()];
      if (files.has('test/generated.test.js')) cases.push(testCase('test/generated.test.js', files.get('src/a.ts') === 'GOOD' ? 'passed' : 'failed'));
      return result(cases.some(item => item.status === 'failed') ? 'failed' : 'passed', cases);
    } },
    agent: { resetBudget: () => { calls = 0; tokens = 0; }, usage: () => ({ calls, tokens, complete: true }),
      design: async () => invoke(() => ({ ...answer(), steps: [{ id: 'issue-step', title: 'Fix negative quantity validation', acceptanceIds: ['issue-request'], dependsOn: [] }] })),
      review: async () => invoke(() => answer()),
      plan: async (_base, _head, description, _signal, mode) => invoke(() => {
        const quote = description.includes('Acceptance:') ? description.split('Acceptance:\n')[1]!.split('\nAllowed paths:')[0]! : issue.title + '\n' + issue.body;
        return { ...answer([{ path: 'test/generated.test.js', content: 'test("negative", () => {});' }]),
          scenarios: [{ name: 'negative', requirement: quote, requirementQuote: quote,
            kind: mode === 'feature' ? 'new_behavior' : 'regression', testFile: 'test/generated.test.js' }] };
      }), repair: async () => invoke(() => answer([{ path: 'src/a.ts', content: 'GOOD' }])) } };
  return { d, issue, dataDir, feedback, modelCalls: () => modelCalls, publications: () => publications };
}
