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
  priorityLabels: string[]): CandidateSignal {
  const labelIndex = priorityLabels.findIndex(label => issue.labels.some(item => item.name === label));
  return { kind: 'issue', repository, identity: [issue.number], commit, branch, issue: issue.number,
    evidence: [issueDigest(issue), issue.user.login, issue.labels.map(item => item.name).sort()],
    title: issue.title, detail: issue.title + '\n' + (issue.body ?? ''),
    priority: labelIndex < 0 ? 60 : 70 + priorityLabels.length - labelIndex,
    priorityReasons: labelIndex < 0 ? ['Trusted, labeled Issue'] : ['Trusted, labeled Issue', `Priority label: ${priorityLabels[labelIndex]}`] };
}
function trustedIssue(issue: QueueIssue, queue: NonNullable<IterationConfig['queue']>) {
  return !issue.pull_request && issue.state === 'open'
    && queue.trustedAuthors.includes(issue.user?.login ?? '')
    && queue.labels.every(label => issue.labels?.some(item => item.name === label));
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
  const queue = d.config.iteration?.queue;
  if (queue) {
    const target = await d.github.target();
    for (const issue of (await d.github.issues('open')).filter(item => trustedIssue(item, queue)).slice(0, 100))
      signals.push(issueSignal(repository, issue, target.branch, target.sha, queue.priorityLabels));
  }
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

export async function refreshCandidates(d: CandidateDependencies) {
  const signals = await collectCandidateSignals(d), existing = new Map((await d.candidates.list())
    .filter(item => item.repository === d.config.repository).map(item => [item.id, item]));
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
    previous.status = 'stale'; previous.reason = 'Source is no longer present in current discovery evidence.';
    previous.updatedAt = now(); await d.candidates.save(previous); stale++;
  }
  return { created, stale, candidates: orderCandidates((await d.candidates.list())
    .filter(item => item.repository === d.config.repository)) };
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
  const current = (await collectCandidateSignals(d)).find(signal => taskId([signal.repository, signal.kind, signal.identity]) === id);
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
    if (candidate.detail.length > 2000 || candidate.title.length < 8) throw new Error('Issue request requires an explicit bounded goal.');
    const issue = await d.github.issue(candidate.issue!) as QueueIssue;
    const target = await d.github.target(candidate.branch);
    if (!trustedIssue(issue, queue) || target.sha !== candidate.commit
      || issueDigest(issue) !== issueDigest({ title: candidate.title, body: candidate.detail.slice(candidate.title.length + 1) }))
      throw new Error('Issue or target branch changed before reproduction.');
    const source = { number: candidate.issue!, title: issue.title, body: issue.body ?? '', branch: target.branch };
    const report = await withFreshness(async signal => {
      const snapshot = await pinnedSnapshot(d, candidate.commit, signal);
      return runPipeline({ base: snapshot, head: snapshot, baseSha: candidate.commit, headSha: candidate.commit,
        issue: source, description: candidate.detail, runKey: taskId(['candidate-reproduce', id, candidate.evidenceDigest]),
        implementation: { mode: 'bugfix', acceptance: [candidate.detail], allowedPaths: queue.allowedPaths },
        reproductionOnly: true }, { ...d.config, publish: false }, d.store, d.runner, d.agent, signal);
    }, async () => {
      const latest = await d.github.issue(candidate.issue!) as QueueIssue;
      return (await d.github.target(candidate.branch)).sha === candidate.commit
        && trustedIssue(latest, queue) && issueDigest(latest) === issueDigest(issue);
    },
    d.config.freshnessSeconds * 1000, d.signal);
    const latest = await d.github.issue(candidate.issue!) as QueueIssue;
    if (!trustedIssue(latest, queue) || issueDigest(latest) !== issueDigest(issue)
      || (await d.github.target(candidate.branch)).sha !== candidate.commit) {
      candidate.status = 'stale'; candidate.reason = 'Issue authorization or target changed during reproduction.';
      candidate.updatedAt = now(); await d.candidates.save(candidate); return candidate;
    }
    const reproduced = report.reproduction?.reproduced === true && passed(report.tests.base)
      && report.testStability?.status === 'stable';
    candidate.reproduction = { status: reproduced ? 'reproduced' : 'not_reproduced', reportId: report.id,
      at, reason: report.reproduction?.reason ?? 'Issue reproduction has no terminal evidence.' };
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
  const current = trusted ? issueSignal(d.config.repository, issue, target.branch, target.sha, queue.priorityLabels) : undefined;
  if (!current || candidateFromSignal(current).evidenceDigest !== candidate.evidenceDigest) {
    candidate.status = 'stale'; candidate.reason = 'Issue authorization or pinned inputs changed.';
    candidate.updatedAt = now(); await d.candidates.save(candidate); return candidate;
  }
  const report = await d.store.read(candidate.reproduction.reportId);
  const input = { baseSha: candidate.commit, headSha: candidate.commit, issue: {
    number: candidate.issue, title: issue.title, body: issue.body ?? '', branch: candidate.branch },
    description: candidate.detail, runKey: taskId(['candidate-reproduce', id, candidate.evidenceDigest]),
    implementation: { mode: 'bugfix' as const, acceptance: [candidate.detail], allowedPaths: queue.allowedPaths },
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
    goal = await createGoal({ title: issue.title, objective: text, mode: 'bugfix', issue: candidate.issue,
      branch: candidate.branch, acceptance: [{ id: 'issue-request', text }], allowedPaths: queue.allowedPaths }, d,
    { candidateId: id, expectedSha: candidate.commit });
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
