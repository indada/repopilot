import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { FileCandidateStore } from '../src/adapters/storage/candidate-store.js';
import { Store } from '../src/adapters/storage/file-store.js';
import { FileIterationStore } from '../src/adapters/storage/iteration-store.js';
import { approveCandidate, refreshCandidates, reproduceCandidate, runCandidate, type CandidateDependencies } from '../src/application/candidates.js';
import { createGoal } from '../src/application/iteration.js';
import { candidateFromSignal } from '../src/domain/candidate.js';
import { configSchema } from '../src/domain/config.js';
import type { QueueIssue } from '../src/ports/automation.js';
import { answer, result, testCase } from './helpers.js';

const sha = 'a'.repeat(40);
async function fixture(): Promise<{ d: CandidateDependencies; issue: QueueIssue; published: () => number }> {
  await mkdir('.cache/tests', { recursive: true });
  const dataDir = await mkdtemp(resolve('.cache/tests/candidates-'));
  const config = configSchema.parse({ repository: 'owner/repo', dataDir, agent: { enabled: true, repair: true },
    iteration: { queue: { labels: ['agent-ready'], trustedAuthors: ['maintainer'], allowedPaths: ['src', 'test'] } } });
  const issue: QueueIssue = { number: 7, title: 'Reject negative quantities', body: 'Negative quantities must produce a validation error.',
    state: 'open', user: { login: 'maintainer' }, labels: [{ name: 'agent-ready' }], created_at: '2026-01-01T00:00:00Z' };
  const snapshot = new Map([['src/a.ts', 'BROKEN']]);
  let writes = 0;
  const d: CandidateDependencies = { config, store: new Store(dataDir), goals: new FileIterationStore(dataDir),
    candidates: new FileCandidateStore(dataDir), signal: new AbortController().signal,
    github: { issues: async () => [issue], issue: async () => issue, target: async () => ({ branch: 'main', sha }),
      listPulls: async () => [], pull: async () => { throw new Error('Unexpected PR read'); },
      current: async report => report.goal ? issue : undefined, publish: async () => { writes++; return undefined; },
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
          scenarios: [{ name: 'negative', requirement: quote, requirementQuote: quote, kind: 'regression', testFile: 'test/generated.test.js' }] };
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
