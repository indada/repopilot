import assert from 'node:assert/strict';
import test from 'node:test';
import { discover, maintainGoal, type AutomationDependencies } from '../src/application/automation.js';
import { GitHub } from '../src/adapters/github/client.js';
import { configSchema } from '../src/domain/config.js';
import { feedbackDigest, integrateBase } from '../src/domain/feedback.js';
import { taskId } from '../src/domain/identity.js';
import type { GoalState } from '../src/domain/iteration.js';
import type { PullFeedback, QueueIssue } from '../src/ports/automation.js';
import { agent, pr, result, store, verifiedReport } from './helpers.js';

async function fixture() {
  const config = configSchema.parse({ repository: 'owner/repo', agent: { enabled: true, repair: true }, iteration: {
    maintenance: { trustedReviewers: ['maintainer'], requiredChecks: ['tests'] },
    queue: { labels: ['agent-ready'], trustedAuthors: ['maintainer'], allowedPaths: ['src'] }
  } });
  const state: GoalState = { schemaVersion: 1, id: 'a'.repeat(24), repository: config.repository,
    spec: { title: 'Implement a feature', objective: 'Implement the requested behavior', mode: 'feature', acceptance: [{ id: 'feature', text: 'Implement the requested behavior' }], allowedPaths: ['src', 'test'] },
    configHash: taskId(config), branch: 'main', sha: pr.base.sha, createdAt: '', updatedAt: '', status: 'published', steps: [], completed: [], changes: [], reports: [], rounds: 0, calls: 0, tokens: 0, elapsedMs: 0, notes: [], publication: 'b'.repeat(24), pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
  const feedback: PullFeedback = { pr: { ...pr, head: { ...pr.head, ref: `autofix/goal-${state.id}/${state.publication}` }, draft: true }, headRun: state.publication, checks: [{ name: 'tests', status: 'completed', conclusion: 'success' }], comments: [] };
  const goals = [state];
  const dependencies: AutomationDependencies = { config, store: await store(), signal: new AbortController().signal,
    goals: { read: async () => state, save: async () => {}, list: async () => goals, pause: async () => {}, paused: async () => false, unpause: async () => {}, remember: async () => {}, experiences: async () => [] },
    github: { listPulls: async () => [], pull: async () => feedback.pr, current: async () => undefined, publish: async () => undefined,
      issue: async () => { throw new Error('Unexpected Issue read'); }, target: async () => ({ branch: 'main', sha: state.sha }), issues: async () => [], feedback: async () => feedback,
      outcome: async () => ({ pr: feedback.pr, checks: feedback.checks }),
      updatePull: async () => { throw new Error('Unexpected publish'); }, recoverPull: async () => undefined, propose: async () => { throw new Error('Unexpected proposal'); } },
    repository: { resolveCommit: async () => state.sha, prepare: async () => {}, fetch: async () => {}, snapshot: async () => new Map([['src/a.ts', 'GOOD']]) },
    runner: { run: async () => result() }, agent: agent() };
  return { d: dependencies, state, feedback, goals };
}

test('review maintenance never truncates oversized requirements', async () => {
  const { d, state, feedback } = await fixture();
  feedback.comments = [{ id: 'long-review', author: 'maintainer', body: 'x'.repeat(2001) }];
  assert.equal((await maintainGoal(state.id, d)).status, 'needs_attention');
  assert.equal(state.calls, 0);
});

test('base integration preserves unrelated work, advances from the last base and rejects conflicts', () => {
  const old = new Map([['src/a.ts', 'old'], ['src/b.ts', 'original']]);
  const base = new Map([['src/a.ts', 'base'], ['src/b.ts', 'original']]);
  const head = new Map([['src/a.ts', 'old'], ['src/b.ts', 'repair']]);
  const merged = integrateBase(old, base, head);
  assert.equal(merged.get('src/a.ts'), 'base'); assert.equal(merged.get('src/b.ts'), 'repair');
  const next = new Map(base); next.set('src/a.ts', 'new base');
  assert.equal(integrateBase(base, next, merged).get('src/a.ts'), 'new base');
  assert.throws(() => integrateBase(old, next, merged), /conflict/);
});

test('maintenance waits for configured checks and ignores untrusted reviews', async () => {
  const { d, state, feedback } = await fixture();
  feedback.checks = [];
  assert.equal((await maintainGoal(state.id, d)).status, 'waiting_for_ci');
  feedback.checks = [{ name: 'tests', status: 'completed', conclusion: 'success' }];
  feedback.comments = [{ id: 'outside', author: 'stranger', body: 'Please change all behavior' }];
  assert.equal((await maintainGoal(state.id, d)).status, 'ready_for_review');
  assert.equal(state.calls, 0);
});

test('maintenance recognizes its latest integrated base without rerunning work', async () => {
  const { d, state, feedback } = await fixture();
  feedback.pr.base = { ...feedback.pr.base, sha: 'c'.repeat(40) };
  state.maintenance = { reportId: 'previous', digest: 'previous', consumed: [], head: feedback.pr.head.sha, base: feedback.pr.base.sha, outcome: 'updated' };
  assert.equal((await maintainGoal(state.id, d)).status, 'ready_for_review');
  assert.equal(state.rounds, 0);
});

test('maintenance rejects renamed, foreign and manually modified heads before execution', async () => {
  for (const change of ['branch', 'foreign', 'head', 'marker']) {
    const { d, state, feedback } = await fixture();
    if (change === 'branch') feedback.pr.head.ref = 'someone-elses-branch';
    if (change === 'foreign') feedback.pr.head.repo = { full_name: 'other/repo' };
    if (change === 'marker') feedback.headRun = undefined;
    if (change === 'head') state.maintenance = { reportId: 'old', digest: 'old', consumed: [], head: 'c'.repeat(40) };
    await assert.rejects(maintainGoal(state.id, d), /owned branch|published goal evidence/);
    assert.equal(state.calls, 0);
  }
});

test('paused goals do not fetch feedback or reserve a budget', async () => {
  const { d, state } = await fixture();
  d.goals.paused = async () => true;
  d.github.feedback = async () => { throw new Error('Unexpected feedback read'); };
  assert.equal((await maintainGoal(state.id, d)).status, 'paused');
  assert.equal(state.calls, 0);
});

test('failed follow-ups may retry with fresh run keys but remain budget bounded', async () => {
  const { d, state, feedback } = await fixture();
  feedback.checks[0]!.conclusion = 'failure';
  d.repository.snapshot = async () => { throw new Error('temporary snapshot failure'); };
  await assert.rejects(maintainGoal(state.id, d), /snapshot failure/);
  const previous = state.maintenance!.reportId;
  assert.equal(state.maintenance?.outcome, 'failed');
  await assert.rejects(maintainGoal(state.id, d), /snapshot failure/);
  assert.notEqual(state.maintenance!.reportId, previous);
  state.rounds = d.config.iteration!.maxRounds;
  await assert.rejects(maintainGoal(state.id, d), /budget exhausted/);
});

test('discovery requires an exact preview and publication policy, then deduplicates proposals', async () => {
  const { d } = await fixture();
  const report = verifiedReport(); report.status = 'needs_attention'; report.tests.base = result('failed');
  await d.store.save(report);
  const preview = await discover(d);
  assert.equal(preview.proposals.length, 1); assert.deepEqual(preview.published, []);
  await assert.rejects(discover(d, 'wrong'), /preview changed/);
  await assert.rejects(discover(d, preview.token), /publish=true/);
  d.config.publish = true;
  const created: QueueIssue[] = [];
  d.github.issues = async () => created;
  d.github.propose = async (title, body) => { created.push({ number: 20, state: 'open', title, body, user: { login: 'bot' }, labels: [], created_at: '' }); return 'https://github.com/owner/repo/issues/20'; };
  assert.equal((await discover(d, preview.token)).published.length, 1);
  assert.deepEqual((await discover(d, preview.token)).published, []);
});

test('GitHub follow-up uses a non-force merge commit and returns the exact published SHA', async () => {
  const { feedback } = await fixture(); const client = new GitHub('owner/repo', 'fixture');
  client.feedback = async () => feedback;
  const writes: { path: string; body: any }[] = [];
  client.request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (method !== 'GET') writes.push({ path, body });
    if (path.startsWith('git/commits/')) return { tree: { sha: 'parent-tree' } } as T;
    if (path.startsWith('git/trees/')) return { truncated: false, tree: [{ path: 'src/a.ts', type: 'blob', mode: '100755' }] } as T;
    return { sha: path === 'git/trees' ? 'new-tree' : 'new-commit' } as T;
  };
  const published = await client.updatePull(verifiedReport(), 1, feedback.pr.head.sha, feedback.pr.base.sha, feedbackDigest(feedback));
  assert.equal(published?.head, 'new-commit');
  assert.deepEqual(writes.find(w => w.path === 'git/commits')!.body.parents, [feedback.pr.head.sha, feedback.pr.base.sha]);
  assert.equal(writes.find(w => w.path.startsWith('git/refs/'))!.body.force, false);
  assert.equal(writes.find(w => w.path === 'git/trees')!.body.tree[0].mode, '100755');
});

test('GitHub follow-up refuses stale feedback and unsupported tree modes', async () => {
  const { feedback } = await fixture(); const client = new GitHub('owner/repo', 'fixture');
  client.feedback = async () => feedback;
  client.request = async <T>(path: string, method = 'GET'): Promise<T> => {
    assert.equal(method, 'GET');
    return (path.startsWith('git/commits/') ? { tree: { sha: 'parent-tree' } } : { truncated: false, tree: [{ path: 'src/a.ts', type: 'blob', mode: '120000' }] }) as T;
  };
  assert.equal(await client.updatePull(verifiedReport(), 1, feedback.pr.head.sha, feedback.pr.base.sha, 'stale'), undefined);
  await assert.rejects(client.updatePull(verifiedReport(), 1, feedback.pr.head.sha, feedback.pr.base.sha, feedbackDigest(feedback)), /file mode/);
});

test('publication recovery checks saved report, exact parents and the full committed tree', async () => {
  const { createHash } = await import('node:crypto');
  const { feedback } = await fixture(); const client = new GitHub('owner/repo', 'fixture'), report = verifiedReport();
  const published = 'd'.repeat(40), branch = feedback.pr.head.ref;
  client.pull = async () => ({ ...feedback.pr, head: { ...feedback.pr.head, sha: published } });
  const content = Buffer.from(report.changes[0]!.content);
  const blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  let tampered = false, badParent = false;
  client.request = async <T>(path: string, method = 'GET'): Promise<T> => {
    assert.equal(method, 'GET');
    if (path === 'git/commits/' + published) return { message: 'fix\n\nRepoPilot-Run: ' + report.id, tree: { sha: 'after' }, parents: [{ sha: badParent ? 'other' : report.head }, { sha: report.base }] } as T;
    if (path === 'git/commits/' + report.head) return { tree: { sha: 'before' } } as T;
    return { truncated: false, tree: [{ path: 'src/a.ts', mode: '100644', type: 'blob', sha: path.includes('after') ? (tampered ? 'unexpected' : blob) : 'old' }] } as T;
  };
  assert.equal((await client.recoverPull(report, 1, branch))?.head, published);
  tampered = true; assert.equal(await client.recoverPull(report, 1, branch), undefined);
  tampered = false; badParent = true; assert.equal(await client.recoverPull(report, 1, branch), undefined);
});

test('maintenance reconciles an interrupted remote update without another repair or budget refund', async () => {
  const { d, state, feedback } = await fixture(); const report = verifiedReport(); await d.store.save(report);
  state.maintenance = { reportId: report.id, digest: 'old', consumed: [], outcome: 'running', pendingComments: ['review-7'] };
  state.calls = 4; state.activeSince = new Date(Date.now() - 1000).toISOString(); feedback.headRun = report.id;
  d.github.recoverPull = async () => ({ url: state.pullRequestUrl!, head: feedback.pr.head.sha });
  d.repository.prepare = async () => { throw new Error('Reconciliation must not execute a repair'); };
  assert.equal((await maintainGoal(state.id, d)).status, 'recovered');
  assert.equal(state.maintenance.head, feedback.pr.head.sha); assert.equal(state.maintenance.base, report.base);
  assert.deepEqual(state.maintenance.consumed, ['review-7']); assert.equal(state.calls, 4); assert.equal(state.activeSince, undefined);
  assert.equal((await d.store.read(report.id))?.status, 'published');
});

test('freshness changes during Git data construction prevent ref updates', async () => {
  const { feedback } = await fixture(); const client = new GitHub('owner/repo', 'fixture');
  let calls = 0, refs = 0;
  client.feedback = async () => { calls++; return calls === 1 ? feedback : { ...feedback, comments: [{ id: 'new', author: 'maintainer', body: 'A newly arrived review' }] }; };
  client.request = async <T>(path: string): Promise<T> => {
    if (path.startsWith('git/refs/')) refs++;
    if (path.startsWith('git/commits/')) return { tree: { sha: 'parent' } } as T;
    if (path.startsWith('git/trees/')) return { truncated: false, tree: [] } as T;
    return { sha: 'constructed' } as T;
  };
  assert.equal(await client.updatePull(verifiedReport(), 1, feedback.pr.head.sha, feedback.pr.base.sha, feedbackDigest(feedback)), undefined);
  assert.equal(refs, 0);
});

test('maintenance independently verifies base integration and retains generated tests before updating the PR', async () => {
  const { testCase } = await import('./helpers.js');
  const { d, state, feedback } = await fixture();
  d.config.publish = true; state.configHash = taskId(d.config);
  const nextBase = 'c'.repeat(40); feedback.pr.base = { ...feedback.pr.base, sha: nextBase };
  d.repository.snapshot = async (_cache, sha) => new Map([['src/a.ts', 'GOOD'], ...(sha === nextBase ? [['src/b.ts', 'base addition'] as [string, string]] : [])]);
  d.runner = { run: async files => result('passed', [testCase(), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js')] : [])]) };
  let writes = 0;
  d.github.updatePull = async report => {
    writes++; assert.equal(report.status, 'verified');
    assert.ok(report.changes.some(c => c.path === 'src/b.ts'));
    assert.ok(report.changes.some(c => c.path === 'test/generated.test.js'));
    assert.equal(report.tests.repaired?.cases.length, 2);
    return { url: state.pullRequestUrl!, head: 'd'.repeat(40) };
  };
  assert.equal((await maintainGoal(state.id, d)).status, 'updated');
  assert.equal(writes, 1); assert.equal(state.maintenance?.base, nextBase); assert.equal(state.maintenance?.head, 'd'.repeat(40));
});

test('failed CI without independently reproduced failure cannot publish generated tests as a fix', async () => {
  const { testCase } = await import('./helpers.js');
  const { d, state, feedback } = await fixture();
  d.config.publish = true; state.configHash = taskId(d.config); feedback.checks[0]!.conclusion = 'failure';
  d.runner = { run: async files => result('passed', [testCase(), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js')] : [])]) };
  assert.equal((await maintainGoal(state.id, d)).status, 'ci_not_reproduced');
  assert.equal(state.maintenance?.outcome, 'failed');
});

test('maintenance retains failed patch fingerprints across rounds and settles actual over-budget usage', async () => {
  const { testCase, answer } = await import('./helpers.js');
  const { d, state, feedback } = await fixture();
  feedback.checks[0]!.conclusion = 'failure'; state.changes = [{ path: 'src/a.ts', content: 'BAD' }];
  d.repository.snapshot = async (_cache, sha) => new Map([['src/a.ts', sha === feedback.pr.head.sha ? 'BAD' : 'GOOD']]);
  d.runner = { run: async files => {
    const status = files.get('src/a.ts') === 'GOOD' ? 'passed' : 'failed';
    return result(status, [testCase(undefined, status), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js', status)] : [])]);
  } };
  let repairs = 0;
  d.agent!.repair = async () => { repairs++; return answer([{ path: 'src/a.ts', content: 'BAD2' }]); };
  assert.equal((await maintainGoal(state.id, d)).status, 'needs_attention');
  assert.ok(state.maintenance!.patches?.length);
  const previous = repairs;
  assert.equal((await maintainGoal(state.id, d)).status, 'needs_attention');
  assert.equal(repairs - previous, 1);
  const report = await d.store.read(state.maintenance!.reportId);
  assert.match(report!.repairs[0]!.reason!, /Repeated patch/);
  const calls = state.calls, tokens = state.tokens;
  d.agent!.usage = () => ({ calls: d.config.agent.maxCalls + 1, tokens: d.config.agent.maxTokens + 17 });
  d.repository.prepare = async () => { throw new Error('budget fixture'); };
  await assert.rejects(maintainGoal(state.id, d), /budget fixture/);
  assert.equal(state.calls - calls, d.config.agent.maxCalls + 1);
  assert.equal(state.tokens - tokens, d.config.agent.maxTokens + 17);
});
