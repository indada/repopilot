import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { FileCandidateStore } from '../src/adapters/storage/candidate-store.js';
import { Store } from '../src/adapters/storage/file-store.js';
import { FileIterationStore } from '../src/adapters/storage/iteration-store.js';
import { approveCandidate, processIssueCandidates, refreshCandidates, reproduceCandidate, runCandidate, type CandidateDependencies } from '../src/application/candidates.js';
import { createGoal } from '../src/application/iteration.js';
import { executeGoals } from '../src/cli/commands/goals.js';
import { candidateFromSignal } from '../src/domain/candidate.js';
import { configSchema } from '../src/domain/config.js';
import type { QueueIssue } from '../src/ports/automation.js';
import { answer, result, testCase } from './helpers.js';

const sha = 'a'.repeat(40);
async function fixture(options: { autoApprove?: boolean; maxFailures?: number;
  maxPerRun?: number; priorityLabels?: string[]; publish?: boolean } = {}): Promise<{
  d: CandidateDependencies; issue: QueueIssue; published: () => number }> {
  await mkdir('.cache/tests', { recursive: true });
  const dataDir = await mkdtemp(resolve('.cache/tests/candidates-'));
  const { publish = false, ...queueOptions } = options;
  const config = configSchema.parse({ repository: 'owner/repo', dataDir, publish,
    agent: { enabled: true, repair: true },
    iteration: { queue: { labels: ['agent-ready'], trustedAuthors: ['maintainer'],
      allowedPaths: ['src', 'test'], ...queueOptions } } });
  const issue: QueueIssue = { number: 7, title: 'Reject negative quantities', body: 'Negative quantities must produce a validation error.',
    state: 'open', user: { login: 'maintainer' }, labels: [{ name: 'agent-ready' }], created_at: '2026-01-01T00:00:00Z' };
  const snapshot = new Map([['src/a.ts', 'BROKEN']]);
  let writes = 0;
  const d: CandidateDependencies = { config, store: new Store(dataDir), goals: new FileIterationStore(dataDir),
    candidates: new FileCandidateStore(dataDir), signal: new AbortController().signal,
    github: { issues: async () => [issue], issue: async () => issue, target: async () => ({ branch: 'main', sha }),
      listPulls: async () => [], pull: async () => { throw new Error('Unexpected PR read'); },
      current: async report => report.goal ? issue : undefined,
      publish: async () => { writes++; return 'https://github.com/owner/repo/pull/10'; },
      feedback: async () => { throw new Error('Unexpected feedback'); }, updatePull: async () => undefined,
      recoverPull: async () => undefined, propose: async () => { writes++; return ''; },
      outcome: async () => { throw new Error('Unexpected outcome'); } },
    repository: { prepare: async () => {}, fetch: async (_path, _repo, from, to) => {
      assert.equal(from, sha); assert.equal(to, sha);
    }, snapshot: async () => snapshot, resolveCommit: async () => sha },
    runner: { run: async files => {
      const cases = [testCase()];
      if (files.has('test/generated.test.js')) cases.push(testCase('test/generated.test.js',
        files.get('src/a.ts') === 'GOOD' ? 'passed' : 'failed'));
      return result(cases.some(item => item.status === 'failed') ? 'failed' : 'passed', cases);
    } },
    agent: { design: async () => ({ ...answer(), steps: [{ id: 'issue-step', title: 'Fix negative quantity validation',
      acceptanceIds: ['issue-request'], dependsOn: [] }] }), review: async () => answer(),
      plan: async (_base, _head, description) => {
        const quote = description.includes('Acceptance:') ? description.split('Acceptance:\n')[1]!.split('\nAllowed paths:')[0]!
          : issue.title + '\n' + issue.body;
        return { ...answer([{ path: 'test/generated.test.js', content: 'test("negative", () => {});' }]),
          scenarios: [{ name: 'negative', requirement: quote, requirementQuote: quote,
            kind: issue.labels.some(label => label.name === 'enhancement') ? 'new_behavior' : 'regression',
            testFile: 'test/generated.test.js' }] };
      }, repair: async () => answer([{ path: 'src/a.ts', content: 'GOOD' }]) } };
  return { d, issue, published: () => writes };
}

test('candidate evidence changes invalidate reproduction and approval', async () => {
  const signal = { kind: 'issue' as const, repository: 'owner/repo', identity: [7], commit: sha,
    branch: 'main', evidence: ['request'], title: 'Reject negative values', detail: 'A regression exists.',
    priority: 70, priorityReasons: ['trusted'] };
  const first = candidateFromSignal(signal);
  const changed = candidateFromSignal({ ...signal, evidence: ['edited'] }, { ...first, status: 'approved',
    reproduction: { status: 'reproduced', at: '2026-01-01T00:00:00Z', reason: 'stable' } });
  assert.equal(changed.status, 'stale'); assert.equal(changed.reproduction, undefined);
});

test('trusted Issue must reproduce with frozen structured tests before goal creation', async () => {
  const { d, issue, published } = await fixture();
  const refreshed = await refreshCandidates(d);
  assert.equal(refreshed.created, 1);
  const candidate = refreshed.candidates[0]!;
  assert.equal(candidate.kind, 'issue');
  await assert.rejects(approveCandidate(candidate.id, candidate.evidenceDigest, d), /stable reproduction/);
  const reproduced = await reproduceCandidate(candidate.id, d);
  assert.equal(reproduced.status, 'reproduced');
  const report = await d.store.read(reproduced.reproduction!.reportId!);
  assert.equal(report?.reproduction?.reproduced, true);
  assert.equal(report?.changes.length, 0);
  assert.equal(report?.attempts, 0);
  assert.equal(published(), 0);
  await assert.rejects(approveCandidate(candidate.id, 'b'.repeat(24), d), /evidence changed/);
  await approveCandidate(candidate.id, candidate.evidenceDigest, d);
  issue.body = 'Edited acceptance after approval.';
  assert.equal((await runCandidate(candidate.id, d)).status, 'stale');
  assert.deepEqual(await d.goals.list(), []);
});

test('tampered reproduction report cannot start a goal', async () => {
  const { d } = await fixture();
  const candidate = (await refreshCandidates(d)).candidates[0]!;
  await reproduceCandidate(candidate.id, d); await approveCandidate(candidate.id, candidate.evidenceDigest, d);
  const original = (await d.store.read((await d.candidates.read(candidate.id))!.reproduction!.reportId!))!;
  original.tests.base = result('failed'); await d.store.save(original);
  await assert.rejects(runCandidate(candidate.id, d), /reproduction evidence/);
  assert.deepEqual(await d.goals.list(), []);
});

test('Issue label revocation during reproduction leaves no approvable candidate', async () => {
  const { d, issue } = await fixture();
  const candidate = (await refreshCandidates(d)).candidates[0]!;
  const runner = d.runner!;
  d.runner = { run: async (files, phase, signal) => {
    if (phase === 'planned-head') issue.labels = [];
    return runner.run(files, phase, signal);
  } };
  assert.equal((await reproduceCandidate(candidate.id, d)).status, 'stale');
  await assert.rejects(approveCandidate(candidate.id, candidate.evidenceDigest, d), /stable reproduction/);
});

test('changing the feature label during reproduction invalidates its test mode', async () => {
  const { d, issue } = await fixture();
  const candidate = (await refreshCandidates(d)).candidates[0]!;
  const runner = d.runner!;
  d.runner = { run: async (files, phase, signal) => {
    if (phase === 'planned-head') issue.labels.push({ name: 'enhancement' });
    return runner.run(files, phase, signal);
  } };
  assert.equal((await reproduceCandidate(candidate.id, d)).status, 'stale');
  assert.deepEqual(await d.goals.list(), []);
});

test('a reproduced, approved Issue creates one recoverable goal', async () => {
  const { d, published } = await fixture();
  const candidate = (await refreshCandidates(d)).candidates[0]!;
  await reproduceCandidate(candidate.id, d); await approveCandidate(candidate.id, candidate.evidenceDigest, d);
  const completed = await runCandidate(candidate.id, d);
  assert.equal(completed.status, 'completed', JSON.stringify(await d.goals.list())); assert.equal(published(), 0);
  assert.equal((await d.goals.list()).length, 1);
  assert.equal((await d.goals.read(completed.goalId!))?.candidateId, candidate.id);
  assert.equal((await runCandidate(candidate.id, d)).goalId, completed.goalId);
  assert.equal((await d.goals.list()).length, 1);
});

test('candidate execution recovers a goal saved before the candidate link', async () => {
  const { d, issue } = await fixture();
  const candidate = (await refreshCandidates(d)).candidates[0]!;
  await reproduceCandidate(candidate.id, d); await approveCandidate(candidate.id, candidate.evidenceDigest, d);
  const request = issue.title + '\n' + issue.body;
  const goal = await createGoal({ title: issue.title, objective: request, mode: 'bugfix', issue: issue.number,
    branch: 'main', acceptance: [{ id: 'issue-request', text: request }], allowedPaths: ['src', 'test'] }, d,
  { candidateId: candidate.id, expectedSha: sha });
  const saved = (await d.candidates.read(candidate.id))!;
  saved.status = 'running'; await d.candidates.save(saved);
  assert.equal((await runCandidate(candidate.id, d)).goalId, goal.id);
  assert.equal((await d.goals.list()).length, 1);
});

test('polling reproduces once and waits for explicit approval by default', async () => {
  const { d } = await fixture();
  let plans = 0;
  const agent = d.agent!, original = agent.plan;
  agent.plan = async (...args) => { plans++; return original(...args); };
  const first = await processIssueCandidates(d);
  assert.equal(first.processed[0]?.status, 'reproduced'); assert.equal(first.pendingApproval, 1);
  assert.deepEqual(await d.goals.list(), []);
  assert.equal((await processIssueCandidates(d)).processed.length, 0);
  assert.equal(plans, 1);
  const candidate = (await d.candidates.list())[0]!;
  await approveCandidate(candidate.id, candidate.evidenceDigest, d);
  const resumed = await processIssueCandidates(d);
  assert.equal(resumed.processed[0]?.status, 'completed');
  assert.equal((await d.goals.list()).length, 1);
  assert.equal((await processIssueCandidates(d)).processed.length, 0);
  assert.equal((await d.goals.list()).length, 1);
});

test('opt-in automatic approval reaches a single verified goal after stable reproduction', async () => {
  const { d, published } = await fixture({ autoApprove: true });
  const first = await processIssueCandidates(d);
  assert.equal(first.processed[0]?.status, 'completed'); assert.equal(first.errors.length, 0);
  assert.equal((await d.goals.list())[0]?.candidateId, first.processed[0]?.id);
  assert.equal((await d.goals.list())[0]?.status, 'verified'); assert.equal(published(), 0);
  assert.equal((await processIssueCandidates(d)).processed.length, 0);
  assert.equal((await d.goals.list()).length, 1);
});

test('opt-in publication happens once after candidate and goal verification', async () => {
  const { d, published } = await fixture({ autoApprove: true, publish: true });
  const cycle = await processIssueCandidates(d);
  assert.equal(cycle.processed[0]?.status, 'completed');
  assert.equal((await d.goals.list())[0]?.status, 'published');
  assert.equal(published(), 1);
  await processIssueCandidates(d);
  assert.equal(published(), 1);
});

test('feature-labeled Issues prove missing behavior before automatic implementation', async () => {
  const { d, issue } = await fixture({ autoApprove: true });
  issue.labels.push({ name: 'enhancement' });
  const result = await processIssueCandidates(d);
  const candidate = (await d.candidates.list())[0]!;
  const report = candidate.reproduction?.reportId ? await d.store.read(candidate.reproduction.reportId) : undefined;
  assert.equal(result.processed[0]?.status, 'completed', JSON.stringify({ result, report }));
  assert.equal((await d.goals.list())[0]?.spec.mode, 'feature');
  assert.equal((await d.store.read(candidate.reproduction!.reportId!))?.reproduction?.reproduced, true);
});

test('automatic feature intake stops when the generated behavior already passes', async () => {
  const { d, issue } = await fixture({ autoApprove: true });
  issue.labels.push({ name: 'enhancement' });
  d.runner = { run: async () => result('passed', [testCase(), testCase('test/generated.test.js')]) };
  const cycle = await processIssueCandidates(d);
  assert.equal(cycle.processed[0]?.status, 'blocked');
  assert.equal((await d.candidates.list())[0]?.reproduction?.status, 'not_reproduced');
  assert.deepEqual(await d.goals.list(), []);
});

test('iterate CLI uses the candidate queue and defaults to manual approval', async () => {
  const { d } = await fixture();
  const output: string[] = [];
  assert.equal(await executeGoals('iterate', undefined, undefined, { once: true }, d,
    { write: line => output.push(line), error: line => assert.fail(line) }), 0);
  assert.equal(JSON.parse(output.at(-1)!).queue.pendingApproval, 1);
  assert.deepEqual(await d.goals.list(), []);
});

test('changed Issue evidence invalidates approval and prevents duplicate goal budgets', async () => {
  const { d, issue } = await fixture();
  await processIssueCandidates(d);
  const original = (await d.candidates.list())[0]!, reportId = original.reproduction!.reportId;
  await approveCandidate(original.id, original.evidenceDigest, d);
  issue.body = 'Negative quantities must be rejected before saving the order.';
  const updated = await processIssueCandidates(d);
  assert.equal(updated.processed[0]?.status, 'reproduced');
  assert.notEqual((await d.candidates.read(original.id))?.reproduction?.reportId, reportId);
  assert.deepEqual(await d.goals.list(), []);
  await approveCandidate(original.id, (await d.candidates.read(original.id))!.evidenceDigest, d);
  await processIssueCandidates(d);
  assert.equal((await d.goals.list()).length, 1);
  issue.body = 'A third changed requirement must not replenish the goal budget.';
  const third = await processIssueCandidates(d);
  assert.equal(third.processed[0]?.status, 'blocked');
  assert.equal((await d.goals.list()).length, 1);
});

test('revoked labels and oversized Issues do not enter automatic execution', async () => {
  const { d, issue } = await fixture({ autoApprove: true });
  issue.body = 'x'.repeat(2000);
  const long = await processIssueCandidates(d);
  assert.equal(long.processed[0]?.status, 'blocked');
  assert.deepEqual(await d.goals.list(), []);
  issue.body = 'Short acceptance request.';
  issue.title = 'T'.repeat(201);
  const wide = await processIssueCandidates(d);
  assert.equal(wide.processed[0]?.status, 'blocked');
  assert.equal(wide.errors.length, 0);
  assert.deepEqual(await d.goals.list(), []);
  issue.labels = [];
  const revoked = await processIssueCandidates(d);
  assert.equal(revoked.processed.length, 0);
  assert.equal((await d.candidates.list())[0]?.status, 'stale');
  assert.deepEqual(await d.goals.list(), []);
});

test('an Issue returning to the trusted queue can be revalidated after its source disappeared', async () => {
  const { d, issue } = await fixture();
  await processIssueCandidates(d);
  const original = (await d.candidates.list())[0]!;
  d.github.issues = async () => [];
  await processIssueCandidates(d);
  const absent = (await d.candidates.read(original.id))!;
  assert.equal(absent.status, 'stale'); assert.equal(absent.reproduction, undefined);
  d.github.issues = async () => [issue];
  const returned = await processIssueCandidates(d);
  assert.equal(returned.processed[0]?.status, 'reproduced');
  assert.equal(returned.pendingApproval, 1);
  assert.deepEqual(await d.goals.list(), []);
});

test('polling persists bounded infrastructure backoff and stops after its retry limit', async () => {
  const { d } = await fixture({ maxFailures: 2 });
  d.repository.fetch = async () => { throw new Error('temporary fetch outage'); };
  const first = await processIssueCandidates(d);
  assert.equal(first.errors.length, 1);
  const candidate = (await d.candidates.list())[0]!;
  assert.equal(candidate.failureCount, 1); assert.ok(candidate.retryAfter);
  assert.equal((await processIssueCandidates(d)).errors.length, 0, 'retry window suppresses immediate replay');
  candidate.retryAfter = new Date(0).toISOString(); await d.candidates.save(candidate);
  const second = await processIssueCandidates(d);
  assert.equal(second.errors.length, 1);
  assert.equal((await d.candidates.read(candidate.id))?.status, 'blocked');
  assert.equal((await processIssueCandidates(d)).errors.length, 0);
  assert.deepEqual(await d.goals.list(), []);
});

test('polling resumes a candidate whose goal was saved before its candidate link', async () => {
  const { d, issue } = await fixture();
  await processIssueCandidates(d);
  const candidate = (await d.candidates.list())[0]!;
  await approveCandidate(candidate.id, candidate.evidenceDigest, d);
  const request = issue.title + '\n' + issue.body;
  const goal = await createGoal({ title: issue.title, objective: request, mode: 'bugfix', issue: issue.number,
    branch: 'main', acceptance: [{ id: 'issue-request', text: request }], allowedPaths: ['src', 'test'] }, d,
  { candidateId: candidate.id, expectedSha: sha });
  const pending = (await d.candidates.read(candidate.id))!;
  pending.status = 'running'; await d.candidates.save(pending);
  await d.goals.pause(goal.id);
  assert.equal((await processIssueCandidates(d)).processed.length, 0, 'automatic polling respects an operator pause');
  await d.goals.unpause(goal.id);
  const resumed = await processIssueCandidates(d);
  assert.equal(resumed.processed[0]?.status, 'completed');
  assert.equal(resumed.processed[0]?.goalId, goal.id);
  assert.equal((await d.goals.list()).length, 1);
});

test('strategy gate blocks new admission but preserves already approved recovery', async () => {
  const { d } = await fixture();
  await processIssueCandidates(d);
  const candidate = (await d.candidates.list())[0]!;
  await approveCandidate(candidate.id, candidate.evidenceDigest, d);
  const resumed = await processIssueCandidates(d, false);
  assert.equal(resumed.deferredByStrategy, true);
  assert.equal(resumed.processed[0]?.status, 'completed');
  assert.equal((await d.goals.list()).length, 1);
});

test('target movement between discovery and reproduction stops automatic execution', async () => {
  const { d } = await fixture({ autoApprove: true });
  let reads = 0;
  d.github.target = async () => ({ branch: 'main', sha: ++reads === 1 ? sha : 'b'.repeat(40) });
  const cycle = await processIssueCandidates(d);
  assert.equal(cycle.processed[0]?.status, 'stale');
  assert.deepEqual(await d.goals.list(), []);
});

test('Issue edits between candidate validation and goal creation cannot consume a new goal budget', async () => {
  for (const change of ['body', 'labels'] as const) {
    const { d, issue } = await fixture();
    const candidate = (await refreshCandidates(d)).candidates[0]!;
    await reproduceCandidate(candidate.id, d); await approveCandidate(candidate.id, candidate.evidenceDigest, d);
    let reads = 0;
    d.github.issue = async () => {
      reads++;
      if (reads === 2) {
        if (change === 'body') issue.body = 'The Issue changed before goal creation.';
        else issue.labels = [];
      }
      return issue;
    };
    await assert.rejects(runCandidate(candidate.id, d), /changed before creation|lost queue authorization/);
    assert.deepEqual(await d.goals.list(), []);
  }
});

test('priority and maxPerRun limit automatic work to one candidate per cycle', async () => {
  const { d, issue } = await fixture({ maxPerRun: 1, priorityLabels: ['urgent'] });
  const urgent: QueueIssue = { ...issue, number: 8, labels: [...issue.labels, { name: 'urgent' }] };
  d.github.issues = async () => [issue, urgent];
  d.github.issue = async number => number === 8 ? urgent : issue;
  const first = await processIssueCandidates(d);
  assert.equal(first.processed.length, 1);
  assert.equal((await d.candidates.read(first.processed[0]!.id))?.issue, 8);
  const second = await processIssueCandidates(d);
  assert.equal(second.processed.length, 1);
  assert.equal((await d.candidates.read(second.processed[0]!.id))?.issue, 7);
});
