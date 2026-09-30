import { resolve } from 'node:path';
import { taskId } from '../domain/identity.js';
import { feedbackDigest, integrateBase } from '../domain/feedback.js';
import { issueDigest, patchDigest, withinScope } from '../domain/iteration.js';
import { applyChanges, protectedPath } from '../domain/repair.js';
import { changedPaths } from '../domain/snapshot.js';
import { passed, preservesTests } from '../domain/test-evidence.js';
import type { AutomationGitHub } from '../ports/automation.js';
import { withFreshness } from '../shared/control.js';
import { loadGoal, type IterationDependencies } from './iteration.js';
import { trackPostMerge } from './post-merge.js';
import { runPipeline } from './pipeline.js';

export type AutomationDependencies = IterationDependencies & { github: IterationDependencies['github'] & AutomationGitHub };
export async function discover(d: AutomationDependencies, expected?: string) {
  const reports = (await d.store.list()).filter(r => r.repository === d.config.repository && ['needs_attention', 'error'].includes(r.status));
  const proposals = reports.slice(0, 100).flatMap(report => {
    const findings = [...report.findings, ...report.historical].filter(f => f.severity === 'error');
    return findings.slice(0, 10).map(f => ({ id: taskId([report.repository, report.head, f.ruleId, f.path, f.line]),
      title: `Investigate ${f.ruleId}: ${f.path}`.slice(0, 200),
      body: `Maintainer review required before execution.\n\nRepository: ${report.repository}\nCommit: ${report.head}\nEvidence report: ${report.id}\nPath: ${f.path}:${f.line}\nRule: ${f.ruleId}\n\n${f.message.slice(0, 5000)}` }));
  });
  for (const report of reports.slice(0, 100)) if (!passed(report.tests.base)) proposals.push({
    id: taskId([report.repository, report.base, 'baseline']), title: 'Investigate baseline test failure or missing evidence',
    body: `Maintainer review required before execution.\n\nCommit: ${report.base}\nEvidence report: ${report.id}\n\n${(report.tests.base.reason ?? report.tests.base.output).slice(0, 5000)}` });
  for (const goal of (await d.goals.list()).filter(goal => goal.repository === d.config.repository && goal.postMerge?.status === 'regressed').slice(0, 100)) proposals.push({
    id: taskId([goal.repository, goal.id, goal.postMerge!.mergeSha, goal.postMerge!.reasons]),
    title: `Investigate post-merge regression: ${goal.spec.title}`.slice(0, 200),
    body: `Maintainer review required before execution.\n\nGoal: ${goal.id}\nMerge commit: ${goal.postMerge!.mergeSha ?? 'unknown'}\nPull request: ${goal.pullRequestUrl}\n\n${goal.postMerge!.reasons.join('\n').slice(0, 5000)}`
  });
  const unique = [...new Map(proposals.map(p => [p.id, p])).values()].slice(0, 20), token = taskId(unique);
  if (!expected) return { token, proposals: unique, published: [] as string[] };
  if (expected !== token) throw new Error('Discovery preview changed; inspect a fresh preview.');
  if (!d.config.publish) throw new Error('Publishing proposals requires publish=true.');
  const existing = await d.github.issues('all'), published: string[] = [];
  for (const proposal of unique) {
    d.signal.throwIfAborted();
    const marker = `<!-- repopilot-proposal:${proposal.id} -->`;
    if (existing.some(i => i.body?.includes(marker))) continue;
    published.push(await d.github.propose(proposal.title, proposal.body + '\n\n' + marker));
  }
  return { token, proposals: unique, published };
}

export async function trackGoal(id: string, d: AutomationDependencies) {
  const policy = d.config.iteration?.postMerge;
  if (!policy) throw new Error('Post-merge tracking requires iteration.postMerge.');
  return trackPostMerge(id, { repository: d.config.repository, requiredChecks: policy.requiredChecks,
    requireIssueClosed: policy.requireIssueClosed, goals: d.goals, github: d.github });
}

export async function maintainGoal(id: string, d: AutomationDependencies) {
  const state = await loadGoal(id, d), policy = d.config.iteration?.maintenance;
  if (!policy || !d.runner || !d.agent || !d.config.agent.enabled || !d.config.agent.repair) throw new Error('PR maintenance requires trustedReviewers, requiredChecks, agent repair and runner.');
  if (d.config.iteration?.preview && !d.previewRunner) throw new Error('Configured preview requires an independent preview runner.');
  const match = state.pullRequestUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!match || match[1] !== d.config.repository || !state.publication) throw new Error('Goal has no published PR.');
  if (await d.goals.paused(id)) return { status: 'paused', goal: id };
  const number = Number(match[2]), feedback = await d.github.feedback(number), pr = feedback.pr, digest = feedbackDigest(feedback);
  if (pr.state !== 'open' || pr.head.repo?.full_name !== d.config.repository || pr.base.repo.full_name !== d.config.repository
    || pr.head.ref !== `autofix/goal-${state.id}/${state.publication}` || pr.base.ref !== state.branch) throw new Error('PR is closed or no longer matches the owned branch.');
  if (state.spec.issue) { const issue = await d.github.issue(state.spec.issue); if (issue.state !== 'open' || issueDigest(issue) !== state.issueDigest) throw new Error('Source Issue changed.'); }
  if (state.maintenance && feedback.headRun === state.maintenance.reportId && pr.head.sha !== state.maintenance.head) {
    const report = await d.store.read(state.maintenance.reportId);
    const recovered = report && await d.github.recoverPull(report, number, pr.head.ref);
    if (!recovered) throw new Error('Interrupted PR publication does not match saved evidence.');
    state.maintenance.consumed = [...new Set([...state.maintenance.consumed, ...(state.maintenance.pendingComments ?? [])])];
    state.maintenance.pendingComments = undefined;
    state.maintenance.head = recovered.head; state.maintenance.base = report.base; state.maintenance.outcome = 'updated';
    report.status = 'published'; report.pullRequestUrl = recovered.url; await d.store.save(report);
    // Retain the crash reservation. Unknown consumption is never refunded.
    if (state.activeSince) state.elapsedMs += Math.max(0, Date.now() - Date.parse(state.activeSince));
    state.activeSince = undefined; state.updatedAt = new Date().toISOString(); await d.goals.save(state);
    return { status: 'recovered', report: report.id, url: recovered.url };
  }
  if (state.maintenance?.head ? pr.head.sha !== state.maintenance.head : feedback.headRun !== state.publication) throw new Error('PR head no longer matches the published goal evidence.');
  const comments = feedback.comments.filter(c => policy.trustedReviewers.includes(c.author) && c.body.trim().length >= 8
    && (!c.commit || c.commit === pr.head.sha) && !state.maintenance?.consumed.includes(c.id));
  if (comments.length > 20 || comments.some(c => c.body.length > 2000)) return { status: 'needs_attention', goal: id, reason: 'Review feedback exceeds bounded acceptance context; create an explicit goal without truncating requirements.' };
  const checks = policy.requiredChecks.map(name => feedback.checks.filter(c => c.name === name));
  if (checks.some(group => !group.length || group.some(c => c.status !== 'completed'))) return { status: 'waiting_for_ci', goal: id };
  const failed = checks.flat().filter(c => c.conclusion !== 'success');
  if (state.maintenance?.digest === digest && ['verified', 'updated'].includes(state.maintenance.outcome ?? '')) return { status: 'already_attempted', goal: id };
  if (!comments.length && !failed.length && pr.base.sha === (state.maintenance?.base ?? state.sha)) return { status: 'ready_for_review', goal: id };
  const fresh = async () => {
    if (await d.goals.paused(id)) return false;
    if (state.spec.issue) {
      const issue = await d.github.issue(state.spec.issue);
      if (issue.pull_request || issue.state !== 'open' || issueDigest(issue) !== state.issueDigest) return false;
      if (state.queued) {
        const queued = issue as import('../ports/automation.js').QueueIssue, queue = d.config.iteration?.queue;
        if (!queue || !queue.trustedAuthors.includes(queued.user?.login ?? '') || !queue.labels.every(l => queued.labels?.some(v => v.name === l))) return false;
      }
    }
    return feedbackDigest(await d.github.feedback(number)) === digest;
  };
  if (!await fresh()) return { status: 'stale', goal: id };
  if (state.activeSince) { state.elapsedMs += Math.max(0, Date.now() - Date.parse(state.activeSince)); state.activeSince = undefined; }
  const limits = d.config.iteration!;
  if (state.rounds >= limits.maxRounds * Math.max(1, state.steps.length) || state.calls + d.config.agent.maxCalls > limits.maxCalls
    || state.tokens + d.config.agent.maxTokens > limits.maxTokens || state.elapsedMs >= limits.timeoutSeconds * 1000) throw new Error('Goal maintenance budget exhausted.');
  const start = Date.now(), signal = AbortSignal.any([d.signal, AbortSignal.timeout(limits.timeoutSeconds * 1000 - state.elapsedMs)]);
  state.rounds++; state.calls += d.config.agent.maxCalls; state.tokens += d.config.agent.maxTokens;
  const runKey = taskId(['follow-up', id, digest, state.rounds]);
  state.maintenance = { ...state.maintenance, reportId: runKey, digest, consumed: state.maintenance?.consumed ?? [], outcome: 'running' };
  state.activeSince = new Date().toISOString();
  await d.goals.save(state); d.agent.resetBudget?.();
  try {
    return await withFreshness(async controlled => {
      const cache = resolve(d.config.dataDir, 'git-cache'); await d.repository.prepare(cache);
      await d.repository.fetch(cache, d.config.repository, pr.base.sha, pr.head.sha, controlled);
      await d.repository.fetch(cache, d.config.repository, state.maintenance?.base ?? state.sha, state.maintenance?.base ?? state.sha, controlled);
      const ancestor = await d.repository.snapshot(cache, state.maintenance?.base ?? state.sha, controlled), base = await d.repository.snapshot(cache, pr.base.sha, controlled), head = await d.repository.snapshot(cache, pr.head.sha, controlled);
      if (!state.maintenance?.head) {
        const owned = state.changes.length ? applyChanges(ancestor, state.changes) : ancestor;
        if (changedPaths(owned, head).length) throw new Error('Published PR tree differs from the verified goal.');
      }
      const integrated = integrateBase(ancestor, base, head);
      if (changedPaths(base, integrated).some(protectedPath)) throw new Error('PR modifies protected policy/configuration relative to the current base.');
      if (changedPaths(head, integrated).some(p => !integrated.has(p) || (head.modes?.get(p) ?? '100644') !== (integrated.modes?.get(p) ?? '100644'))) throw new Error('Base integration requires deletion/mode review.');
      const description = comments.map(c => c.body.slice(0, 2000)).join('\n');
      const useFeature = comments.length > 0 && failed.length === 0;
      const report = await runPipeline({ previousPatches: state.maintenance?.patches, base: useFeature ? integrated : base, head: integrated, baseSha: pr.base.sha, headSha: pr.head.sha,
        description: useFeature ? `Feature implementation from maintainer review:\n${description}` : `${pr.title}\n${pr.body}\nCI feedback: ${JSON.stringify(failed)}\nMaintainer review:\n${description}`, runKey, keepBudget: true,
        implementation: useFeature ? { mode: 'feature', acceptance: comments.map(c => c.body.slice(0, 2000)), allowedPaths: state.spec.allowedPaths } : undefined
      }, { ...d.config, publish: false }, d.store, d.runner, d.agent, controlled);
      state.maintenance!.reportId = report.id;
      state.maintenance!.patches = [...new Set([...(state.maintenance!.patches ?? []), ...report.repairs.filter(r => !r.accepted).map(r => patchDigest(r.changes))])];
      await d.goals.save(state);
      if (!['verified', 'passed'].includes(report.status)) return { status: 'needs_attention', report: report.id };
      if (failed.length && report.status !== 'verified') return { status: 'ci_not_reproduced', report: report.id };
      if (report.changes.some(c => !withinScope(c.path, state.spec.allowedPaths))) throw new Error('Follow-up repair exceeds allowed paths.');
      const changes = report.changes.length ? report.changes : report.plan?.tests ?? [];
      if (changes.some(c => !withinScope(c.path, state.spec.allowedPaths))) throw new Error('Follow-up tests exceed allowed paths.');
      const candidate = changes.length ? applyChanges(integrated, changes) : integrated;
      const verified = await d.runner!.run(candidate, 'follow-up-final', controlled);
      if (!passed(verified) || !preservesTests(report.tests.base, verified) || !preservesTests(report.tests.head, verified) || (report.tests.repaired && !preservesTests(report.tests.repaired, verified))) throw new Error('Follow-up final verification failed.');
      report.changes = changedPaths(head, candidate).map(path => ({ path, content: candidate.get(path)! }));
      if (!report.changes.length) return { status: failed.length ? 'ci_not_reproduced' : 'no_changes', report: report.id };
      if (d.previewRunner) {
        const preview = await d.previewRunner.run(candidate, 'follow-up-preview', controlled), rollback = await d.previewRunner.run(head, 'follow-up-rollback', controlled);
        if (!passed(preview) || !passed(rollback) || !preservesTests(rollback, preview)) throw new Error('Follow-up preview/rollback verification failed.');
      }
      report.status = 'verified'; report.tests.repaired = verified; await d.store.save(report);
      if (!await fresh()) return { status: 'stale', report: report.id };
      if (!d.config.publish) { state.maintenance!.outcome = 'verified'; return { status: 'verified', report: report.id }; }
      state.maintenance!.pendingComments = useFeature ? comments.map(c => c.id) : [];
      await d.goals.save(state);
      const update = await d.github.updatePull(report, number, pr.head.sha, pr.base.sha, digest, controlled);
      if (!update) return { status: 'stale', report: report.id };
      const { url, head: publishedHead } = update;
      report.status = 'published'; report.pullRequestUrl = url; await d.store.save(report);
      if (useFeature) state.maintenance!.consumed.push(...comments.map(c => c.id));
      state.maintenance!.pendingComments = undefined;
      state.maintenance!.head = publishedHead; state.maintenance!.base = pr.base.sha; state.maintenance!.outcome = 'updated';
      return { status: 'updated', report: report.id, url };
    }, fresh, d.config.freshnessSeconds * 1000, signal);
  } finally {
    const usage = d.agent.usage?.();
    if (usage) { state.calls += usage.calls - d.config.agent.maxCalls; state.tokens += (usage.complete === false ? Math.max(d.config.agent.maxTokens, usage.tokens) : usage.tokens) - d.config.agent.maxTokens; }
    if (state.maintenance?.outcome === 'running') state.maintenance.outcome = 'failed';
    state.activeSince = undefined;
    state.elapsedMs += Date.now() - start; state.updatedAt = new Date().toISOString(); await d.goals.save(state);
  }
}
