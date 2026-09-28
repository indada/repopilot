import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { FileIterationStore } from '../src/adapters/storage/iteration-store.js';
import { Store } from '../src/adapters/storage/file-store.js';
import { compareEvaluationProfiles } from '../src/application/evaluation.js';
import { replayEvaluationSuite } from '../src/application/evaluation-replay.js';
import type { IterationDependencies } from '../src/application/iteration.js';
import { configSchema } from '../src/domain/config.js';
import { strategyGateSchema, type GoalState } from '../src/domain/iteration.js';
import { answer, result, testCase } from './helpers.js';

const sha = 'a'.repeat(40);
function record(caseId: string, profile: string, status: GoalState['status'] = 'verified'): GoalState {
  return { schemaVersion: 1, id: (caseId + profile).padEnd(24, 'a').slice(0, 24), repository: 'owner/repo',
    configHash: profile + '-configuration', evaluationRunId: caseId + profile,
    spec: { title: 'Reject negative quantities', objective: 'Reject a negative quantity before saving an order.', mode: 'bugfix',
      acceptance: [{ id: 'negative', text: 'Negative quantities must produce a validation error.' }], allowedPaths: ['src', 'test'],
      branch: 'main', evaluation: { suite: 'core-suite', case: caseId, profile } },
    branch: 'main', sha, createdAt: '', updatedAt: '', status, steps: [], completed: [], changes: [],
    reports: [], rounds: 1, calls: profile === 'baseline' ? 10 : 12,
    tokens: profile === 'baseline' ? 100 : 110, elapsedMs: profile === 'baseline' ? 1000 : 1200, notes: [] };
}

test('strategy gate compares matching replay cases and rejects regression, cost and evidence drift', () => {
  const rules = strategyGateSchema.parse({ suite: 'core-suite', baselineProfile: 'baseline', candidateProfile: 'candidate',
    minCases: 2, minVerificationRate: 1 });
  const states = [record('one', 'baseline'), record('two', 'baseline'), record('one', 'candidate'), record('two', 'candidate')];
  assert.equal(compareEvaluationProfiles(states, rules).eligible, true);
  assert.match(compareEvaluationProfiles(states, rules, 'other-config').reasons.join(' '), /current controller configuration/);
  const failed = states.map(state => ({ ...state, spec: { ...state.spec, evaluation: { ...state.spec.evaluation! } } }));
  failed[3]!.status = 'needs_attention';
  assert.match(compareEvaluationProfiles(failed, rules).reasons.join(' '), /lost a verified case/);
  const costly = states.map(state => ({ ...state })); costly[2]!.calls = 100;
  assert.match(compareEvaluationProfiles(costly, rules).reasons.join(' '), /calls exceeds/);
  const drift = states.map(state => ({ ...state })); drift[2]!.sha = 'b'.repeat(40);
  assert.match(compareEvaluationProfiles(drift, rules).reasons.join(' '), /inputs differ/);
  const missingReplay = states.map(state => ({ ...state })); missingReplay[2]!.evaluationRunId = undefined;
  assert.match(compareEvaluationProfiles(missingReplay, rules).reasons.join(' '), /fixed-case replay/);
  const incomplete = states.map(state => ({ ...state })); incomplete[2]!.status = 'running';
  assert.match(compareEvaluationProfiles(incomplete, rules).reasons.join(' '), /terminal/);
  assert.match(compareEvaluationProfiles([...states, states[0]!], rules).reasons.join(' '), /Duplicate/);
});

test('fixed-case replay runs once on the pinned snapshot and never publishes', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const dataDir = await mkdtemp(resolve('.cache/tests/eval-replay-'));
  const config = configSchema.parse({ repository: 'owner/repo', dataDir, publish: true,
    agent: { enabled: true, repair: true }, iteration: {} });
  const snapshot = new Map([['src/a.ts', 'BROKEN']]);
  let moved = false, publication = 0, plans = 0;
  const deps: IterationDependencies = { config, goals: new FileIterationStore(dataDir), store: new Store(dataDir),
    signal: new AbortController().signal,
    github: { target: async () => ({ branch: 'main', sha: moved ? 'b'.repeat(40) : sha }),
      issue: async () => { throw new Error('Evaluation must not read a live Issue'); },
      listPulls: async () => [], pull: async () => { throw new Error('No PR'); },
      current: async report => !moved && report.goal ? { number: 0, title: report.goal.title, body: '', state: 'open' } : undefined,
      publish: async () => { publication++; return undefined; } },
    repository: { prepare: async () => {}, fetch: async (_path, _repo, from, to) => {
      assert.equal(from, sha); assert.equal(to, sha);
    }, snapshot: async () => snapshot, resolveCommit: async () => sha },
    runner: { run: async files => {
      const cases = [testCase()];
      if (files.has('test/generated.test.js')) cases.push(testCase('test/generated.test.js',
        files.get('src/a.ts') === 'GOOD' ? 'passed' : 'failed'));
      return result(cases.some(item => item.status === 'failed') ? 'failed' : 'passed', cases);
    } },
    agent: { design: async () => ({ ...answer(), steps: [{ id: 'negative', title: 'Reject negative quantity input',
      acceptanceIds: ['negative'], dependsOn: [] }] }), review: async () => answer(),
      plan: async () => { plans++; const quote = 'Negative quantities must produce a validation error.';
        return { ...answer([{ path: 'test/generated.test.js', content: 'test("negative", () => {});' }]),
          scenarios: [{ name: 'negative', requirement: quote, requirementQuote: quote,
            kind: 'regression', testFile: 'test/generated.test.js' }] };
      }, repair: async () => answer([{ path: 'src/a.ts', content: 'GOOD' }]) } };
  const suite = { schemaVersion: 1, repository: 'owner/repo', suite: 'core-suite', cases: [{
    id: 'negative', branch: 'main', sha,
    spec: { title: 'Reject negative quantities', objective: 'Reject a negative quantity before saving an order.',
      mode: 'bugfix', acceptance: [{ id: 'negative', text: 'Negative quantities must produce a validation error.' }],
      allowedPaths: ['src', 'test'] } }] };
  const first = await replayEvaluationSuite(suite, 'candidate', deps);
  assert.equal(first.cases[0]?.status, 'verified', JSON.stringify(await deps.goals.list())); assert.equal(publication, 0);
  assert.equal((await deps.goals.list()).length, 1);
  const count = plans;
  const second = await replayEvaluationSuite(suite, 'candidate', deps);
  assert.equal(second.cases[0]?.goalId, first.cases[0]?.goalId);
  assert.equal(plans, count); assert.equal((await deps.goals.list()).length, 1);
  moved = true;
  await assert.rejects(replayEvaluationSuite(suite, 'candidate', deps), /pinned branch/);
  await assert.rejects(replayEvaluationSuite({ ...suite, cases: [{ ...suite.cases[0], spec: {
    ...suite.cases[0]!.spec, issue: 7 } }] }, 'candidate', deps), /Evaluation cases/);
});
