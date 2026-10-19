import type { Config } from '../domain/config.js';
import { configDigest } from '../domain/identity.js';
import { pollEvent } from '../domain/service-events.js';
import { passed } from '../domain/test-evidence.js';
import type { QueuedEvent, ServiceConfig, ServiceEvent } from '../domain/service.js';
import type { ProgressGitHub, ServiceStore } from '../ports/service.js';
import { AutomationPausedError, pause, RetryableError } from '../shared/control.js';
import { maintainGoal, trackGoal } from './automation.js';
import { approveCandidate, processIssueCandidates, refreshCandidates, type CandidateDependencies } from './candidates.js';
import { compareEvaluationProfiles } from './evaluation.js';
import { ServiceBudget } from './service-budget.js';
import { flushProgress, queueCandidateProgress, queueProgress } from './service-progress.js';
import { reviewPull } from './watch.js';

export type ServiceDependencies = CandidateDependencies & { services: ServiceStore; budget: ServiceBudget;
  github: CandidateDependencies['github'] & ProgressGitHub };
export function serviceSettings(config: Config): ServiceConfig {
  if (!config.service) throw new Error('Configure service before using the service controller.');
  return config.service;
}
export function validateService(config: Config) {
  const service = serviceSettings(config);
  if (!config.iteration?.queue && !config.iteration?.maintenance && !config.iteration?.postMerge && !service.reviewPullRequests)
    throw new Error('Service requires Issue intake, goal follow-up or explicit reviewPullRequests.');
  if (config.agent.enabled && service.limits.dailyTokens < config.agent.maxTokens)
    throw new Error('Daily token limit must fit at least one agent.maxTokens reservation.');
}

async function reconcile(delivery: string, d: ServiceDependencies) {
  const config = serviceSettings(d.config), keys = new Map<string, { kind: 'issue' | 'pull'; number: number }>();
  if (d.config.iteration?.queue) {
    const refreshed = await refreshCandidates(d, 'issues'), active = new Set(refreshed.activeIds);
    for (const candidate of refreshed.candidates) if (active.has(candidate.id)
      && (['observed', 'stale', 'approved', 'running'].includes(candidate.status)
        || candidate.status === 'reproduced' && d.config.iteration.queue.autoApprove))
      keys.set('issue:' + candidate.issue, { kind: 'issue', number: candidate.issue! });
  }
  for (const goal of await d.goals.list()) if (goal.repository === d.config.repository && goal.status === 'published'
    && (d.config.iteration?.maintenance || d.config.iteration?.postMerge)
    && !['healthy', 'regressed', 'closed_unmerged'].includes(goal.postMerge?.status ?? '')) {
    const match = goal.pullRequestUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
    if (match?.[1] === d.config.repository) keys.set('pull:' + match[2], { kind: 'pull', number: Number(match[2]) });
  }
  if (config.reviewPullRequests) for (const pr of await d.github.listPulls())
    if (pr.state === 'open' && !pr.draft && pr.head.repo?.full_name === d.config.repository && !pr.head.ref.startsWith('autofix/'))
      keys.set('pull:' + pr.number, { kind: 'pull', number: pr.number });
  const pending = (await d.services.events(d.config.repository)).filter(item => !item.receipt || ['pending', 'processing'].includes(item.receipt.status));
  const queued = new Set(pending.map(item => item.event.key));
  let remaining = config.queue.maxPending - pending.length;
  for (const [key, value] of keys) {
    if (queued.has(key)) continue;
    if (remaining-- <= 0) break;
    await d.services.enqueue(pollEvent(d.config.repository, delivery + ':' + key, value.kind, value.number), config.queue.maxPending);
  }
}

type Outcome = 'success' | 'failure' | 'neutral';
interface WorkResult { status: string; outcome: Outcome; retryAfter?: string; detail?: unknown; }
async function processObject(event: ServiceEvent, d: ServiceDependencies, approvals: NonNullable<ServiceEvent['approval']>[] = []): Promise<WorkResult> {
  if (event.kind === 'reconcile') { await reconcile(event.delivery, d); return { status: 'reconciled', outcome: 'neutral' }; }
  if (event.kind === 'issue') {
    if (!d.config.iteration?.queue) return { status: 'Issue intake disabled', outcome: 'neutral' };
    let rejectedApprovals = 0;
    if (approvals.length) {
      await refreshCandidates(d, 'issues');
      for (const approval of approvals) {
        const candidate = await d.candidates.read(approval.candidateId);
        if (!candidate || candidate.issue !== event.number || candidate.repository !== event.repository
          || candidate.evidenceDigest !== approval.evidenceDigest
          || !['reproduced', 'approved', 'running', 'completed'].includes(candidate.status)) {
          rejectedApprovals++; continue;
        }
        if (candidate.status === 'reproduced') await approveCandidate(candidate.id, approval.evidenceDigest, d);
      }
      if (rejectedApprovals === approvals.length)
        return { status: 'Operator approval rejected; current Issue evidence no longer matches', outcome: 'neutral' };
    }
    const gate = d.config.iteration.strategyGate
      ? compareEvaluationProfiles((await d.goals.list()).filter(goal => goal.repository === d.config.repository),
        d.config.iteration.strategyGate, configDigest({ ...d.config, publish: false })) : undefined;
    const result = await processIssueCandidates(d, gate?.eligible ?? true, [event.number!]);
    if (result.errors.length) throw new RetryableError(result.errors.map(item => item.error).join(' '));
    const candidate = (await d.candidates.list()).find(item => item.repository === d.config.repository && item.issue === event.number);
    const waiting = candidate && (['approved', 'running', 'observed'].includes(candidate.status)
      || candidate.status === 'reproduced' && d.config.iteration.queue.autoApprove);
    const retryAfter = waiting ? candidate.retryAfter ?? new Date(Date.now() + d.config.pollSeconds * 1000).toISOString() : undefined;
    const report = candidate?.reproduction?.reportId ? await d.store.read(candidate.reproduction.reportId) : undefined;
    const goal = candidate?.goalId ? await d.goals.read(candidate.goalId) : undefined;
    const verificationFailed = goal?.status === 'needs_attention' || report?.status === 'error'
      || report?.testStability?.status === 'unstable' || report?.testStability?.status === 'inconclusive'
      || report && !passed(report.tests.base);
    const outcome = result.processed.some(item => item.status === 'completed' || item.status === 'reproduced') ? 'success'
      : result.processed.some(item => item.status === 'blocked') && verificationFailed ? 'failure' : 'neutral';
    const deferred = result.deferredByDecision.some(item => item.id === candidate?.id);
    return { status: deferred ? 'Decision deferred automatic intake; human review required' : candidate?.status ?? 'No authorized candidate',
      outcome, retryAfter, detail: { ...result, rejectedApprovals } };
  }
  const owned = (await d.goals.list()).find(goal => goal.repository === d.config.repository
    && goal.pullRequestUrl === `https://github.com/${d.config.repository}/pull/${event.number}` && goal.status === 'published');
  if (owned) {
    if (await d.goals.paused(owned.id)) return { status: 'Goal paused by operator', outcome: 'neutral',
      retryAfter: new Date(Date.now() + d.config.pollSeconds * 1000).toISOString() };
    let status = 'ready_for_review', outcome: Outcome = 'neutral';
    if (!d.config.iteration?.postMerge && (await d.github.pull(event.number!)).state !== 'open') {
      if (d.config.service?.progress) await queueProgress(d.services, d.config.repository, event.number!, 'PR closed; automatic follow-up stopped', { goal: owned.id });
      return { status: 'PR closed', outcome: 'neutral' };
    }
    const postMerge = d.config.iteration?.postMerge ? await trackGoal(owned.id, d) : undefined;
    if (postMerge) {
      status = postMerge.status;
      const changed = owned.postMerge?.status !== status || owned.postMerge?.mergeSha !== postMerge.mergeSha;
      outcome = changed && status === 'healthy' ? 'success' : changed && status === 'regressed' ? 'failure' : 'neutral';
    }
    if (d.config.iteration?.maintenance && (!postMerge || postMerge.status === 'waiting_for_merge')) {
      let executed = false;
      const result = await maintainGoal(owned.id, { ...d, onTaskStart: async () => { await d.onTaskStart?.(); executed = true; } });
      status = result.status;
      outcome = ['verified', 'updated', 'recovered'].includes(status) ? 'success'
        : executed && ['needs_attention', 'ci_not_reproduced'].includes(status) ? 'failure' : 'neutral';
    }
    if (d.config.service?.progress) await queueProgress(d.services, d.config.repository, event.number!, status,
      { goal: owned.id, report: owned.publication, commit: owned.sha });
    return { status, outcome };
  }
  if (!d.config.service?.reviewPullRequests) return { status: 'PR review disabled', outcome: 'neutral' };
  let executed = false;
  const report = await reviewPull(event.number!, { ...d, onTaskStart: async () => { await d.onTaskStart?.(); executed = true; } });
  if (!report) return { status: 'PR is outside the authorized review scope', outcome: 'neutral' };
  if (d.config.service.progress) await queueProgress(d.services, d.config.repository, event.number!, report.status,
    { report: report.id, commit: report.head, url: report.pullRequestUrl });
  if (report.status === 'error' && report.retryable) {
    if (!executed && report.retryAfter) return { status: 'Waiting for PR execution retry', outcome: 'neutral', retryAfter: report.retryAfter };
    throw new RetryableError('PR execution requires an infrastructure retry.', Math.max(0, Date.parse(report.retryAfter ?? '') - Date.now()));
  }
  return { status: report.status, outcome: ['passed', 'verified', 'published'].includes(report.status) ? 'success'
    : executed && ['needs_attention', 'error'].includes(report.status) ? 'failure' : 'neutral' };
}

function hookedDependencies(d: ServiceDependencies, onError: (message: string) => void): ServiceDependencies {
  const source = d.candidates;
  const flush = () => flushProgress(d.services, d.config.repository, d.github, serviceSettings(d.config), d.signal, onError);
  return { ...d, onAdvance: () => d.budget.startTask(), onTaskStart: () => d.budget.startTask(),
    onReproduction: async candidate => {
      if (d.config.service?.progress) { await queueCandidateProgress(d.services, candidate, true); await flush(); }
    },
    candidates: { read: id => source.read(id), list: () => source.list(), save: async candidate => {
      await source.save(candidate);
      if (d.config.service?.progress) {
        const goal = candidate.goalId ? await d.goals.read(candidate.goalId) : undefined;
        await queueCandidateProgress(d.services, candidate, false, goal?.pullRequestUrl);
        if (candidate.status === 'running') await flush();
      }
    } } };
}

/** Pause requests interrupt active work as well as future model calls. */
async function controlled<T>(d: ServiceDependencies, work: (deps: ServiceDependencies) => Promise<T>): Promise<T> {
  const abort = new AbortController(); let checking: Promise<void> | undefined;
  const check = () => {
    if (checking) return;
    checking = d.services.control(d.config.repository).then(control => {
      if (control?.action === 'pause') abort.abort(new AutomationPausedError('Service paused by operator.'));
    }).catch(error => abort.abort(error)).finally(() => { checking = undefined; });
  };
  check(); const interval = setInterval(check, 250);
  try { await checking; return await work({ ...d, signal: AbortSignal.any([d.signal, abort.signal]) }); }
  finally { clearInterval(interval); await checking; }
}

export async function processServiceBatch(deps: ServiceDependencies, onResult: (value: unknown) => void,
  onError: (message: string) => void) {
  const d = hookedDependencies(deps, onError), config = serviceSettings(d.config);
  let processed = 0, failed = 0;
  const seen = new Set<string>();
  while (processed < config.queue.maxBatch && !d.signal.aborted) {
    const records = (await d.services.events(d.config.repository)).filter(item => !item.receipt
      || ['pending', 'processing'].includes(item.receipt.status));
    const groups = new Map<string, QueuedEvent[]>();
    for (const record of records) { const group = groups.get(record.event.key) ?? []; group.push(record); groups.set(record.event.key, group); }
    const status = await d.budget.status();
    const entry = [...groups].find(([key, items]) => !seen.has(key) && (!status.paused || items[0]!.event.kind === 'reconcile')
      && items.some(item => !item.receipt?.retryAfter || Date.parse(item.receipt.retryAfter) <= Date.now()));
    if (!entry) break;
    const [key, items] = entry; seen.add(key); processed++;
    const at = new Date().toISOString();
    for (const item of items) await d.services.receipt(item.event.id, { status: 'processing', attempts: (item.receipt?.attempts ?? 0) + 1, updatedAt: at });
    try {
      const result = items[0]!.event.kind === 'reconcile' ? await processObject(items[0]!.event, d)
        : await controlled(d, controlledDeps => processObject(items[0]!.event, controlledDeps,
          items.filter(item => item.event.source === 'operator' && item.event.approval).map(item => item.event.approval!)));
      if (result.outcome === 'failure') failed++;
      await d.budget.outcome(result.outcome);
      for (const item of items) await d.services.receipt(item.event.id, { status: result.retryAfter ? 'pending' : 'completed',
        attempts: result.retryAfter ? item.receipt?.attempts ?? 0 : (item.receipt?.attempts ?? 0) + 1,
        retryAfter: result.retryAfter, updatedAt: new Date().toISOString(), reason: result.status });
      onResult({ key, deliveries: items.length, ...result });
    } catch (error) {
      if (d.signal.aborted) return { processed, failed };
      const deferred = error instanceof AutomationPausedError;
      if (!deferred) { failed++; await d.budget.outcome('failure'); onError(`Event ${key} failed: ${String(error).slice(0, 1000)}`); }
      for (const item of items) {
        const attempts = (item.receipt?.attempts ?? 0) + (deferred ? 0 : 1);
        const delay = Math.max(error instanceof RetryableError ? error.retryAfterMs : 0,
          Math.min(d.config.retry.maxDelayMs, Math.max(1000, d.config.retry.baseDelayMs) * 2 ** Math.max(0, attempts - 1)));
        await d.services.receipt(item.event.id, { status: !deferred && attempts >= config.queue.maxAttempts ? 'dead' : 'pending', attempts,
          retryAfter: new Date(Date.now() + delay).toISOString(), updatedAt: new Date().toISOString(),
          reason: deferred ? error.message : 'Execution failed; inspect local evidence and controller log.' });
      }
      if (deferred) onResult({ key, status: 'deferred', reason: error.message });
    }
  }
  if (!d.signal.aborted) await flushProgress(d.services, d.config.repository, d.github, config, d.signal, onError);
  return { processed, failed };
}

export async function runService(d: ServiceDependencies, once: boolean, onResult: (value: unknown) => void,
  onError: (message: string) => void) {
  validateService(d.config); const settings = serviceSettings(d.config);
  let nextPoll = 0, failures = 0;
  do {
    if (d.signal.aborted) break;
    if (Date.now() >= nextPoll) {
      const time = Date.now(), delivery = 'poll:' + Math.floor(time / (d.config.pollSeconds * 1000));
      await d.services.prune(d.config.repository, new Date(time - settings.queue.retentionDays * 86400000).toISOString());
      try { await d.services.enqueue(pollEvent(d.config.repository, delivery, 'reconcile'), settings.queue.maxPending); }
      catch (error) { onError(`Reconciliation could not be queued: ${String(error)}`); }
      nextPoll = time + d.config.pollSeconds * 1000;
    }
    const result = await processServiceBatch(d, onResult, onError); failures += result.failed;
    if (!once && !d.signal.aborted) await pause(1000, d.signal).catch(() => undefined);
  } while (!once && !d.signal.aborted);
  return failures ? 1 : 0;
}
