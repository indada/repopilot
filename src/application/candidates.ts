import { resolve } from 'node:path';
import { candidateFromSignal, orderCandidates, type Candidate, type CandidateSignal } from '../domain/candidate.js';
import { pipelineId, taskId } from '../domain/identity.js';
import { issueDigest, type IterationConfig } from '../domain/iteration.js';
import { applyExceptions, introducedFindings, loadPolicy } from '../domain/policy.js';
import { diagnose } from '../domain/test-diagnosis.js';
import { passed, sameFailures } from '../domain/test-evidence.js';
import type { QueueIssue } from '../ports/automation.js';
import type { CandidateStore } from '../ports/candidate.js';
import { withFreshness } from '../shared/control.js';
import { createGoal, runGoal } from './iteration.js';
import { runPipeline } from './pipeline.js';
import type { AutomationDependencies } from './automation.js';

export type CandidateDependencies = AutomationDependencies & { candidates: CandidateStore };
const sha = /^[a-f0-9]{40}$/;
const now = () => new Date().toISOString();

function issueSignal(repository: string, issue: QueueIssue, branch: string, commit: string,
  priorityLabels: string[], configDigest: string): CandidateSignal {
  const labelIndex = priorityLabels.findIndex(label => issue.labels.some(item => item.name === label));
  return { kind: 'issue', repository, identity: [issue.number], commit, branch, issue: issue.number,
    evidence: [issueDigest(issue), issue.user.login, issue.labels.map(item => item.name).sort(), configDigest],
    title: issue.title, detail: issue.title + '\n' + (issue.body ?? ''),
    priority: labelIndex < 0 ? 60 : 70 + priorityLabels.length - labelIndex,
    priorityReasons: labelIndex < 0 ? ['Trusted, labeled Issue'] : ['Trusted, labeled Issue', `Priority label: ${priorityLabels[labelIndex]}`] };
}
function trustedIssue(issue: QueueIssue, queue: NonNullable<IterationConfig['queue']>) {
  return !issue.pull_request && issue.state === 'open'
    && queue.trustedAuthors.includes(issue.user?.login ?? '')
    && queue.labels.every(label => issue.labels?.some(item => item.name === label));
}
function issueMode(issue: QueueIssue, queue: NonNullable<IterationConfig['queue']>): 'bugfix' | 'feature' {
  return issue.labels.some(label => label.name === queue.featureLabel) ? 'feature' : 'bugfix';
}

async function collectIssueSignals(d: AutomationDependencies): Promise<CandidateSignal[]> {
  const queue = d.config.iteration?.queue;
  if (!queue) return [];
  const target = await d.github.target();
  return (await d.github.issues('open')).filter(issue => trustedIssue(issue, queue))
    .map(issue => issueSignal(d.config.repository, issue, target.branch, target.sha,
      queue.priorityLabels, taskId(d.config)));
}

/** Discovery is evidence-only. A source cannot grant its own execution permission. */
export async function collectCandidateSignals(d: AutomationDependencies): Promise<CandidateSignal[]> {
  const repository = d.config.repository, signals: CandidateSignal[] = [];
  const reports = (await d.store.list()).filter(report => report.repository === repository && sha.test(report.head)).slice(0, 100);
  for (const report of reports) {
    for (const finding of report.findings.filter(item => item.severity === 'error').slice(0, 20)) signals.push({
      kind: 'policy', repository, identity: [report.head, finding.ruleId, finding.path],
      evidence: [report.id, report.base, report.head, finding.ruleId, finding.path, finding.message],
      commit: report.head, reportId: report.id, path: finding.path, ruleId: finding.ruleId,
      title: `Review ${finding.ruleId}: ${finding.path}`, detail: finding.message,
      priority: 70, priorityReasons: ['Error-severity repository finding'] });
    if (report.tests.base.status === 'failed' && report.tests.base.structured) signals.push({
      kind: 'baseline', repository, identity: [report.base, 'baseline'],
      evidence: [report.id, report.tests.base.cases.filter(item => item.status === 'failed').map(item => [item.id, item.fingerprint])],
      commit: report.base, reportId: report.id, title: 'Investigate failing baseline tests',
      detail: `Report ${report.id} has failing baseline test evidence.`, priority: 65,
      priorityReasons: ['Structured baseline test failure'] });
  }
  const goals = (await d.goals.list()).filter(goal => goal.repository === repository);
  for (const goal of goals.filter(item => item.postMerge?.status === 'regressed' && sha.test(item.postMerge.mergeSha ?? '')).slice(0, 100)) signals.push({
    kind: 'post_merge', repository, identity: [goal.postMerge!.mergeSha, goal.id],
    evidence: [goal.id, goal.postMerge!.checks, goal.postMerge!.reasons],
    commit: goal.postMerge!.mergeSha!, goalId: goal.id,
    title: `Post-merge regression: ${goal.spec.title}`, detail: goal.postMerge!.reasons.join('\n'),
    priority: 90, priorityReasons: ['Observed merge-commit regression'] });
  signals.push(...await collectIssueSignals(d));
  const maintenance = d.config.iteration?.maintenance;
  if (maintenance) for (const goal of goals.filter(item => item.status === 'published' && item.pullRequestUrl).slice(0, 20)) {
    const number = Number(goal.pullRequestUrl?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/)?.[1]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const feedback = await d.github.feedback(number), pr = feedback.pr;
    const expectedRun = goal.maintenance?.head ?? goal.publication;
    if (pr.state !== 'open' || pr.head.repo?.full_name !== repository || pr.base.repo.full_name !== repository
      || pr.base.ref !== goal.branch || pr.head.ref !== `autofix/goal-${goal.id}/${goal.publication}` || !sha.test(pr.head.sha)
      || (goal.maintenance?.head ? pr.head.sha !== goal.maintenance.head : feedback.headRun !== expectedRun)) continue;
    for (const check of feedback.checks.filter(item => maintenance.requiredChecks.includes(item.name)
      && item.status === 'completed' && item.conclusion !== null && item.conclusion !== 'success')) signals.push({
      kind: 'ci', repository, identity: [pr.head.sha, check.name], evidence: [number, check],
      commit: pr.head.sha, branch: pr.head.ref, goalId: goal.id,
      title: `CI failure: ${check.name}`, detail: `PR #${number}: ${check.name} concluded ${check.conclusion}.`,
      priority: 80, priorityReasons: ['Required CI check failed on an owned PR'] });
    for (const comment of feedback.comments.filter(item => maintenance.trustedReviewers.includes(item.author)
      && item.body.trim().length >= 8 && item.body.length <= 2000
      && (!item.commit || item.commit === pr.head.sha)).slice(0, 20)) signals.push({
      kind: 'review', repository, identity: [number, comment.id], evidence: [pr.head.sha, comment.author, comment.body],
      commit: pr.head.sha, branch: pr.head.ref, goalId: goal.id,
      title: `Review feedback on PR #${number}`, detail: comment.body,
      priority: 50, priorityReasons: ['Feedback from a configured trusted reviewer'] });
  }
  // Newest evidence wins for a repeated root cause; an older report must not invalidate approval.
  const seen = new Set<string>();
  return signals.filter(signal => {
    const id = taskId([signal.repository, signal.kind, signal.identity]);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
}

export async function refreshCandidates(d: CandidateDependencies, scope: 'all' | 'issues' = 'all') {
  const signals = scope === 'issues' ? await collectIssueSignals(d) : await collectCandidateSignals(d);
  const existing = new Map((await d.candidates.list())
    .filter(item => item.repository === d.config.repository && (scope === 'all' || item.kind === 'issue'))
    .map(item => [item.id, item]));
  const seen = new Set<string>(); let created = 0, stale = 0;
  for (const signal of signals) {
    const id = taskId([signal.repository, signal.kind, signal.identity]);
    const previous = existing.get(id), candidate = candidateFromSignal(signal, previous);
    seen.add(id);
    if (!previous) created++;
    if (previous && candidate.status === 'stale' && previous.status !== 'stale') stale++;
    if (!previous || JSON.stringify(candidate) !== JSON.stringify(previous)) await d.candidates.save(candidate);
  }
  for (const previous of existing.values()) if (!seen.has(previous.id)
    && !['stale', 'completed'].includes(previous.status)) {
    previous.status = 'stale'; previous.reproduction = undefined;
    previous.failureCount = undefined; previous.retryAfter = undefined;
    previous.reason = 'Source is no longer present in current discovery evidence.';
    previous.updatedAt = now(); await d.candidates.save(previous); stale++;
  }
  return { created, stale, activeIds: [...seen], candidates: orderCandidates((await d.candidates.list())
    .filter(item => item.repository === d.config.repository && (scope === 'all' || item.kind === 'issue'))) };
}

async function pinnedSnapshot(d: CandidateDependencies, commit: string, signal: AbortSignal = d.signal) {
  const cache = resolve(d.config.dataDir, 'git-cache');
  await d.repository.prepare(cache);
  await d.repository.fetch(cache, d.config.repository, commit, commit, signal);
  return d.repository.snapshot(cache, commit, signal);
}

export async function reproduceCandidate(id: string, d: CandidateDependencies): Promise<Candidate> {
  const candidate = await d.candidates.read(id);
  if (!candidate || candidate.repository !== d.config.repository) throw new Error('Candidate not found in this repository.');
  const currentSignals = candidate.kind === 'issue' ? await collectIssueSignals(d) : await collectCandidateSignals(d);
  const current = currentSignals.find(signal => taskId([signal.repository, signal.kind, signal.identity]) === id);
  if (!current || candidateFromSignal(current).evidenceDigest !== candidate.evidenceDigest) {
    candidate.status = 'stale'; candidate.reason = 'Source evidence changed before reproduction.';
    candidate.updatedAt = now(); await d.candidates.save(candidate); return candidate;
  }
  if (candidate.reproduction?.status === 'reproduced' && ['reproduced', 'approved'].includes(candidate.status)) return candidate;
  if (candidate.kind !== 'policy' && candidate.kind !== 'review' && !d.runner)
    throw new Error('Candidate reproduction requires a structured runner.');
  const at = now();
  if (candidate.kind === 'issue') {
    const queue = d.config.iteration?.queue;
    if (!queue || !d.agent || !d.config.agent.repair) throw new Error('Issue reproduction requires queue, Agent and repair configuration.');
    if (candidate.detail.length > 2000 || candidate.title.length < 8 || candidate.title.length > 200)
      throw new Error('Issue request requires an explicit bounded goal.');
    const issue = await d.github.issue(candidate.issue!) as QueueIssue;
    const target = await d.github.target(candidate.branch);
    const matches = (source: QueueIssue, branch: string, commit: string) => trustedIssue(source, queue)
      && candidateFromSignal(issueSignal(d.config.repository, source, branch, commit,
        queue.priorityLabels, taskId(d.config))).evidenceDigest === candidate.evidenceDigest;
    if (!matches(issue, target.branch, target.sha))
      throw new Error('Issue or target branch changed before reproduction.');
    const source = { number: candidate.issue!, title: issue.title, body: issue.body ?? '', branch: target.branch };
    const report = await withFreshness(async signal => {
      const snapshot = await pinnedSnapshot(d, candidate.commit, signal);
      return runPipeline({ base: snapshot, head: snapshot, baseSha: candidate.commit, headSha: candidate.commit,
        issue: source, description: candidate.detail, runKey: taskId(['candidate-reproduce', id, candidate.evidenceDigest]),
        implementation: { mode: issueMode(issue, queue), acceptance: [candidate.detail], allowedPaths: queue.allowedPaths },
        reproductionOnly: true }, { ...d.config, publish: false }, d.store, d.runner, d.agent, signal);
    }, async () => {
      const latest = await d.github.issue(candidate.issue!) as QueueIssue;
      const currentTarget = await d.github.target(candidate.branch);
      return matches(latest, currentTarget.branch, currentTarget.sha);
    },
    d.config.freshnessSeconds * 1000, d.signal);
    const latest = await d.github.issue(candidate.issue!) as QueueIssue;
    const finalTarget = await d.github.target(candidate.branch);
    if (!matches(latest, finalTarget.branch, finalTarget.sha)) {
      candidate.status = 'stale'; candidate.reason = 'Issue authorization or target changed during reproduction.';
      candidate.updatedAt = now(); await d.candidates.save(candidate); return candidate;
    }
    const reproduced = report.reproduction?.reproduced === true && passed(report.tests.base)
      && report.testStability?.status === 'stable';
    candidate.reproduction = { status: reproduced ? 'reproduced' : 'not_reproduced', reportId: report.id,
      at, reason: report.reproduction?.reason
        ?? `Issue reproduction ended ${report.status}: ${report.notes.at(-1) ?? 'no terminal evidence'}` };
    candidate.status = reproduced ? 'reproduced' : 'blocked';
  } else if (candidate.kind === 'policy') {
    const report = await d.store.read(candidate.reportId!);
    if (!report || report.repository !== candidate.repository || report.head !== candidate.commit) throw new Error('Policy evidence report changed.');
    const base = await pinnedSnapshot(d, report.base), head = await pinnedSnapshot(d, report.head);
    const policy = loadPolicy(base), findings = applyExceptions(introducedFindings(base, head, policy).findings, policy).findings;
    const reproduced = findings.some(item => item.severity === 'error' && item.ruleId === candidate.ruleId && item.path === candidate.path);
    candidate.reproduction = { status: reproduced ? 'reproduced' : 'not_reproduced', at,
      reason: reproduced ? 'Trusted base policy reproduced the same error on the pinned candidate.' : 'Policy finding was not reproduced.' };
    candidate.status = reproduced ? 'reproduced' : 'blocked';
  } else if (candidate.kind === 'review') {
    candidate.reproduction = { status: 'inconclusive', at,
      reason: 'Review prose is not executable evidence; provide an explicit Issue with testable acceptance criteria.' };
    candidate.status = 'blocked';
  } else {
    const snapshot = await pinnedSnapshot(d, candidate.commit);
    const first = diagnose(await d.runner!.run(snapshot, 'candidate-reproduce-first', d.signal));
    const second = diagnose(await d.runner!.run(snapshot, 'candidate-reproduce-second', d.signal));
    const reproduced = sameFailures(first, second);
    candidate.reproduction = { status: reproduced ? 'reproduced'
      : first.status === 'error' || second.status === 'error' ? 'inconclusive' : 'not_reproduced',
      first, second, at, reason: reproduced ? 'The pinned snapshot produced the same structured failures twice.'
        : 'Independent runner did not produce matching structured failures twice.' };
    candidate.status = reproduced ? 'reproduced' : 'blocked';
  }
  candidate.reason = candidate.reproduction.reason; candidate.updatedAt = now();
  await d.candidates.save(candidate); return candidate;
}

export async function approveCandidate(id: string, expected: string, d: CandidateDependencies): Promise<Candidate> {
  const candidate = await d.candidates.read(id);
  if (!candidate || candidate.repository !== d.config.repository) throw new Error('Candidate not found in this repository.');
  if (candidate.evidenceDigest !== expected) throw new Error('Candidate evidence changed; inspect it again.');
  if (candidate.kind !== 'issue') throw new Error('Only reproduced trusted Issues can start a goal; other signals need an explicit Issue.');
  if (candidate.status !== 'reproduced' || candidate.reproduction?.status !== 'reproduced') throw new Error('Candidate needs stable reproduction before approval.');
  candidate.status = 'approved'; candidate.updatedAt = now(); await d.candidates.save(candidate); return candidate;
}

export async function runCandidate(id: string, d: CandidateDependencies): Promise<Candidate> {
  const candidate = await d.candidates.read(id), queue = d.config.iteration?.queue;
  if (!candidate || candidate.repository !== d.config.repository) throw new Error('Candidate not found in this repository.');
  if (candidate.status === 'completed' && candidate.goalId) {
    const goal = await d.goals.read(candidate.goalId);
    if (goal?.candidateId === id && goal.repository === candidate.repository
      && ['verified', 'published'].includes(goal.status)) return candidate;
  }
  if (!queue || candidate.kind !== 'issue' || !candidate.issue || !candidate.branch
    || !candidate.reproduction?.reportId || candidate.reproduction.status !== 'reproduced'
    || !['approved', 'running'].includes(candidate.status)) throw new Error('Only approved, reproduced Issues can start a goal.');
  const issue = await d.github.issue(candidate.issue) as QueueIssue, target = await d.github.target(candidate.branch);
  const trusted = trustedIssue(issue, queue);
  const current = trusted ? issueSignal(d.config.repository, issue, target.branch, target.sha,
    queue.priorityLabels, taskId(d.config)) : undefined;
  if (!current || candidateFromSignal(current).evidenceDigest !== candidate.evidenceDigest) {
    candidate.status = 'stale'; candidate.reason = 'Issue authorization or pinned inputs changed.';
    candidate.updatedAt = now(); await d.candidates.save(candidate); return candidate;
  }
  const report = await d.store.read(candidate.reproduction.reportId);
  const input = { baseSha: candidate.commit, headSha: candidate.commit, issue: {
    number: candidate.issue, title: issue.title, body: issue.body ?? '', branch: candidate.branch },
    description: candidate.detail, runKey: taskId(['candidate-reproduce', id, candidate.evidenceDigest]),
    implementation: { mode: issueMode(issue, queue), acceptance: [candidate.detail], allowedPaths: queue.allowedPaths },
    reproductionOnly: true };
  if (!report?.reproduction?.reproduced || report.repository !== candidate.repository
    || report.id !== pipelineId(input, { ...d.config, publish: false })
    || report.head !== candidate.commit || report.base !== candidate.commit
    || report.status !== 'needs_attention' || report.changes.length || !passed(report.tests.base)
    || report.testStability?.status !== 'stable')
    throw new Error('Pinned reproduction evidence is missing or invalid.');
  const text = issue.title + '\n' + (issue.body ?? '');
  if (text.length > 2000 || text.length < 8) throw new Error('Issue requires an explicit bounded goal.');
  let goal = (await d.goals.list()).find(item => item.repository === d.config.repository && item.candidateId === id);
  if (!goal) {
    if ((await d.goals.list()).some(item => item.repository === d.config.repository && item.spec.issue === candidate.issue))
      throw new Error('Issue was already claimed by another goal.');
    candidate.status = 'running'; candidate.updatedAt = now(); await d.candidates.save(candidate);
    goal = await createGoal({ title: issue.title, objective: text, mode: issueMode(issue, queue), issue: candidate.issue,
      branch: candidate.branch, acceptance: [{ id: 'issue-request', text }], allowedPaths: queue.allowedPaths }, d,
    { candidateId: id, expectedSha: candidate.commit, expectedIssueDigest: issueDigest(issue) });
  }
  candidate.goalId = goal.id; candidate.status = 'running'; candidate.updatedAt = now();
  await d.candidates.save(candidate);
  if (!goal.queued) { goal.queued = true; await d.goals.save(goal); }
  if (goal.status === 'planned' || goal.status === 'running' || goal.status === 'paused') goal = await runGoal(goal.id, d);
  candidate.status = ['verified', 'published'].includes(goal.status) ? 'completed'
    : goal.status === 'needs_attention' || goal.status === 'stale' ? 'blocked' : 'running';
  candidate.reason = `Goal ${goal.id}: ${goal.status}.`; candidate.updatedAt = now();
  await d.candidates.save(candidate); return candidate;
}

/** The polling loop has one controller lock, so only one candidate can advance at a time. */
export async function processIssueCandidates(d: CandidateDependencies, admitNew = true) {
  const queue = d.config.iteration?.queue;
  if (!queue) throw new Error('Configure iteration.queue before processing Issue candidates.');
  const refreshed = await refreshCandidates(d, 'issues'), active = new Set(refreshed.activeIds);
  const candidates = refreshed.candidates.filter(item => active.has(item.id));
  const recover = candidates.filter(item => ['running', 'approved'].includes(item.status));
  const incoming = admitNew ? candidates.filter(item =>
    ['observed', 'stale'].includes(item.status)
    || (item.status === 'reproduced' && queue.autoApprove)) : [];
  const selected = [...recover, ...incoming];
  const processed: { id: string; status: Candidate['status']; goalId?: string; reason?: string }[] = [];
  const errors: { id: string; error: string; retryAfter?: string }[] = [];
  const goals = await d.goals.list();
  for (const initial of selected) {
    if (processed.length + errors.length >= queue.maxPerRun) break;
    d.signal.throwIfAborted();
    if (initial.retryAfter && Date.parse(initial.retryAfter) > Date.now()) continue;
    const linked = goals.find(goal => goal.repository === d.config.repository && goal.candidateId === initial.id);
    if (linked && await d.goals.paused(linked.id)) continue;
    try {
      let candidate = initial;
      if (candidate.status === 'observed' || candidate.status === 'stale') {
        const claimed = goals.find(goal => goal.repository === d.config.repository && goal.spec.issue === candidate.issue);
        if (claimed) {
          candidate.status = 'blocked'; candidate.goalId = claimed.id;
          candidate.reason = 'Issue already belongs to a goal; automatic intake cannot reset its budget.';
          candidate.updatedAt = now(); await d.candidates.save(candidate);
        } else if (candidate.title.length < 8 || candidate.title.length > 200
          || candidate.detail.length < 8 || candidate.detail.length > 2000) {
          candidate.status = 'blocked'; candidate.reason = 'Issue request exceeds the bounded automatic intake limits.';
          candidate.updatedAt = now(); await d.candidates.save(candidate);
        } else candidate = await reproduceCandidate(candidate.id, d);
      }
      if (candidate.status === 'reproduced' && queue.autoApprove) candidate = await approveCandidate(candidate.id, candidate.evidenceDigest, d);
      if (candidate.status === 'approved' || candidate.status === 'running') candidate = await runCandidate(candidate.id, d);
      if (candidate.failureCount || candidate.retryAfter) {
        candidate.failureCount = undefined; candidate.retryAfter = undefined;
        await d.candidates.save(candidate);
      }
      processed.push({ id: candidate.id, status: candidate.status, goalId: candidate.goalId, reason: candidate.reason });
    } catch (error) {
      d.signal.throwIfAborted();
      const candidate = await d.candidates.read(initial.id);
      if (!candidate) throw error;
      const count = (candidate.failureCount ?? 0) + 1;
      const delay = Math.min(Math.max(1000, d.config.retry.maxDelayMs),
        Math.max(1000, d.config.retry.baseDelayMs) * 2 ** (count - 1));
      candidate.failureCount = count;
      candidate.retryAfter = count >= queue.maxFailures ? undefined : new Date(Date.now() + delay).toISOString();
      if (count >= queue.maxFailures) candidate.status = 'blocked';
      candidate.reason = `Candidate advancement failed (${count}/${queue.maxFailures}): ${String(error).slice(0, 1000)}`;
      candidate.updatedAt = now(); await d.candidates.save(candidate);
      errors.push({ id: candidate.id, error: candidate.reason, retryAfter: candidate.retryAfter });
    }
  }
  const pendingApproval = (await d.candidates.list()).filter(item => item.repository === d.config.repository
    && item.kind === 'issue' && active.has(item.id) && item.status === 'reproduced').length;
  return { created: refreshed.created, stale: refreshed.stale, processed, pendingApproval,
    deferredByStrategy: !admitNew, errors };
}
