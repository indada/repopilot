import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../domain/config.js';
import { pipelineId, taskId } from '../domain/identity.js';
import type { RunInput } from '../domain/task.js';
import { goalSpecSchema, issueDigest, patchDigest, validateSteps, withinScope, type GoalState, type WaveAudit } from '../domain/iteration.js';
import { handoffDigest, type AgentHandoff } from '../domain/collaboration.js';
import { applyExceptions, introducedFindings, loadPolicy } from '../domain/policy.js';
import { applyChanges } from '../domain/repair.js';
import { changedPaths, copySnapshot } from '../domain/snapshot.js';
import { mergeParallelChanges, snapshotDigest } from '../domain/parallel-merge.js';
import { parallelCapacity, partitionParallelBranches } from '../domain/parallel-scheduling.js';
import { passed, preservesTests } from '../domain/test-evidence.js';
import type { Report, Snapshot } from '../domain/types.js';
import { roleAgent, type Agent } from '../ports/agent.js';
import type { GitHub, IssueGitHub } from '../ports/github.js';
import type { IterationStore } from '../ports/iteration.js';
import type { Repository } from '../ports/repository.js';
import type { Runner } from '../ports/runner.js';
import type { Store } from '../ports/store.js';
import { pause, StaleTaskError, withFreshness } from '../shared/control.js';
import { runPipeline } from './pipeline.js';
import { finishReport } from './publication.js';

export interface IterationDependencies {
  config: Config; goals: IterationStore; store: Store; github: GitHub & IssueGitHub;
  repository: Repository; agent?: Agent; runner?: Runner; previewRunner?: Runner; signal: AbortSignal;
}
function enabled(d: IterationDependencies) {
  if (!d.config.iteration || !d.agent?.design || !d.runner || !d.config.agent.enabled || !d.config.agent.repair) throw new Error('Goals require iteration configuration, agent.enabled, agent.repair and a runner.');
  return d.config.iteration;
}
async function save(state: GoalState, d: IterationDependencies) { state.updatedAt = new Date().toISOString(); await d.goals.save(state); }
function waveAudit(state: GoalState, capacity: number): WaveAudit {
  const batch = state.parallelBatch!;
  const id = batch.id ?? taskId([state.id, batch.baseDigest, batch.steps.map(step => step.runKey)]);
  batch.id = id;
  state.waveHistory ??= [];
  let audit = state.waveHistory.find(item => item.id === id);
  if (!audit) {
    audit = { id, inputDigest: batch.baseDigest, stepIds: batch.steps.map(step => step.id), capacity,
      status: 'running', accepted: [], deferred: [], rejected: [], conflicts: [], pathOwners: {}, reportIds: {},
      updatedAt: new Date().toISOString() };
    state.waveHistory.push(audit);
    if (state.waveHistory.length > 400) state.waveHistory.shift();
  }
  return audit;
}
function syncStepStates(state: GoalState) {
  const now = new Date().toISOString(), previous = state.stepStates ?? {};
  state.stepStates = Object.fromEntries(state.steps.map(step => {
    const old = previous[step.id], completed = state.completed.includes(step.id);
    const blocked = step.dependsOn.some(id => ['rejected', 'blocked'].includes(previous[id]?.status ?? ''));
    const active = state.active?.step === step.id || state.parallelBatch?.steps.some(item => item.id === step.id);
    const status = completed ? 'completed' : active ? 'running' : blocked ? 'blocked'
      : old?.status === 'rejected' ? 'rejected' : 'pending';
    return [step.id, { attempts: old?.attempts ?? 0, reportId: old?.reportId, reason: old?.reason,
      updatedAt: old?.status === status ? old.updatedAt : now, status }];
  }));
}
async function parallelStepInput(state: GoalState, step: GoalState['steps'][number], working: Snapshot,
  d: IterationDependencies, runKey: string): Promise<RunInput> {
  const criteria = state.spec.acceptance.filter(a => step.acceptanceIds.includes(a.id)).map(a => a.text);
  const previousPatches: string[] = [], priorFeedback: string[] = [];
  for (const reference of state.parallelBatch?.priorReports ?? state.reports) {
    const previous = await d.store.read(reference.split(':')[1]!);
    if (previous) {
      previousPatches.push(...previous.repairs.filter(r => !r.accepted).map(r => patchDigest(r.changes)));
      priorFeedback.push(...previous.notes.slice(-2));
    }
  }
  const pinned = copySnapshot(working);
  return { base: pinned, head: pinned, baseSha: state.sha, headSha: state.sha, runKey, keepBudget: true,
    description: `${state.spec.mode === 'feature' ? 'Feature implementation' : 'Bug reproduction'}: ${state.spec.objective}\nStep: ${step.title}\nAcceptance:\n${criteria.join('\n')}\nAllowed paths: ${state.spec.allowedPaths.join(', ')}\nPrevious verification feedback (untrusted evidence): ${priorFeedback.join('\n').slice(-12000)}`,
    previousPatches, implementation: { mode: state.spec.mode, acceptance: criteria, allowedPaths: state.spec.allowedPaths } };
}
function retryableParallelStep(state: GoalState, step: GoalState['steps'][number], report: Report | undefined,
  limits: NonNullable<IterationDependencies['config']['iteration']>): boolean {
  if (!report || step.acceptanceIds.some(id => (state.criterionAttempts?.[id] ?? 0) >= limits.maxRounds)) return false;
  if (state.rounds >= limits.maxRounds * limits.maxSteps) return false;
  if (report.status === 'error') return report.retryable;
  return report.status === 'needs_attention' && report.tests.repaired?.status === 'failed'
    && report.tests.repaired.structured && report.testStability?.status === 'stable'
    && !report.repairs.some(repair => repair.reason?.includes('Repeated patch'));
}
async function parallelWave(state: GoalState, base: Snapshot, working: Snapshot, d: IterationDependencies, signal: AbortSignal): Promise<Snapshot | undefined> {
  const limits = enabled(d), maxParallel = parallelCapacity(limits.collaboration, d.config.runner);
  if (!d.agent?.forkExecution) throw new Error('Parallel goal execution requires isolated Agent instances.');
  const existing = state.parallelBatch, ready = state.steps.filter(step =>
    !state.completed.includes(step.id) && step.dependsOn.every(id => state.completed.includes(id)));
  const chosen = existing
    ? existing.steps.map(item => state.steps.find(step => step.id === item.id))
    : ready.slice(0, maxParallel);
  if (chosen.some(step => !step || !ready.includes(step))) throw new Error('Stored parallel batch no longer matches its goal graph.');
  const steps = chosen as GoalState['steps'];
  if (existing && existing.baseDigest !== snapshotDigest(working)) throw new Error('Stored parallel batch input changed; refusing replay.');
  if (!existing) {
    if (state.rounds + steps.length > limits.maxRounds * limits.maxSteps) throw new Error('Goal iteration limit reached.');
    for (const step of steps) for (const criterion of step.acceptanceIds) {
      if ((state.criterionAttempts?.[criterion] ?? 0) >= limits.maxRounds) throw new Error('Acceptance retry limit reached.');
    }
    const calls = steps.length * d.config.agent.maxCalls, tokens = steps.length * d.config.agent.maxTokens;
    if (state.calls + calls > limits.maxCalls || state.tokens + tokens > limits.maxTokens)
      throw new Error('Goal model budget exhausted; parallel reservations are not refunded.');
    const batch = { baseDigest: snapshotDigest(working), priorReports: [...state.reports], steps: steps.map((step, index) => ({
      id: step.id, runKey: taskId([state.id, step, state.rounds + index, state.changes]), settled: false })) };
    state.parallelBatch = batch; state.calls += calls; state.tokens += tokens; state.rounds += steps.length;
    waveAudit(state, maxParallel);
    state.criterionAttempts ??= {};
    for (const step of steps) for (const criterion of step.acceptanceIds)
      state.criterionAttempts[criterion] = (state.criterionAttempts[criterion] ?? 0) + 1;
    syncStepStates(state);
    for (const step of steps) {
      const execution = state.stepStates![step.id]!;
      execution.attempts++; execution.updatedAt = new Date().toISOString();
    }
    await save(state, d);
  }
  const batch = state.parallelBatch!;
  const audit = waveAudit(state, maxParallel);
  const interrupt = async (reason: string): Promise<never> => {
    audit.status = 'interrupted'; audit.reason = reason; audit.updatedAt = new Date().toISOString();
    for (const item of batch.steps) Object.assign(state.stepStates![item.id]!, {
      status: 'blocked', reason, updatedAt: new Date().toISOString() });
    await save(state, d);
    throw new Error(reason);
  };
  const inputs = await Promise.all(steps.map((step, index) =>
    parallelStepInput(state, step, working, d, batch.steps[index]!.runKey)));
  const stored = await Promise.all(inputs.map(input => d.store.read(pipelineId(input, { ...d.config, publish: false }))));
  if (existing && stored.some(report => !report || ['running', 'cancelled'].includes(report.status)))
    await interrupt('Interrupted parallel batch lacks terminal evidence; replan to request new bounded executions.');
  const workers = steps.map(() => d.agent!.forkExecution!());
  const results = await Promise.allSettled(inputs.map((input, index) => stored[index]
    ? Promise.resolve(stored[index]!)
    : runPipeline(input, { ...d.config, publish: false }, d.store, d.runner, workers[index]!, signal)));
  const reports: (Report | undefined)[] = [];
  for (let index = 0; index < steps.length; index++) {
    const item = batch.steps[index]!, result = results[index]!;
    const expectedId = pipelineId(inputs[index]!, { ...d.config, publish: false });
    const report = result.status === 'fulfilled' ? result.value : await d.store.read(expectedId);
    if (report && (report.id !== expectedId || report.repository !== state.repository || report.base !== state.sha || report.head !== state.sha))
      await interrupt('Parallel report identity does not match its pinned execution.');
    reports[index] = report;
    if (!item.settled) {
      // An interrupted or unacknowledged execution keeps its full reservation.
      const usage = result.status === 'fulfilled' && report && !['running', 'cancelled'].includes(report.status)
        ? report.agentUsage : undefined;
      if (usage) {
        state.calls += usage.calls - d.config.agent.maxCalls;
        state.tokens += (usage.complete === false ? Math.max(d.config.agent.maxTokens, usage.tokens) : usage.tokens) - d.config.agent.maxTokens;
      }
      item.settled = true;
    }
    if (report) {
      item.reportId = report.id;
      audit.reportIds[item.id] = report.id;
      const reference = item.id + ':' + report.id;
      if (!state.reports.includes(reference)) state.reports.push(reference);
    }
    await save(state, d);
  }
  signal.throwIfAborted();
  if (reports.some(report => !report))
    await interrupt('Parallel step ended without durable report; replan to request a new execution.');
  const reportFor = (step: GoalState['steps'][number]) => reports[steps.indexOf(step)]!;
  const verified = steps.filter((_, index) => reports[index]?.status === 'verified'
    && !!reports[index]?.tests.repaired && passed(reports[index]!.tests.repaired!));
  const rejected = steps.filter(step => !verified.includes(step));
  const retryable = rejected.filter(step => retryableParallelStep(state, step, reportFor(step), limits));
  const terminal = rejected.filter(step => !retryable.includes(step));
  let merged: Snapshot;
  let partition: ReturnType<typeof partitionParallelBranches>;
  try {
    if (verified.some(step => reportFor(step).changes.some(change => !withinScope(change.path, state.spec.allowedPaths))))
      throw new Error('Parallel candidate exceeds the goal allowed paths.');
    partition = partitionParallelBranches(working, verified.map(step => ({ step: step.id, changes: reportFor(step).changes })));
    audit.conflicts = partition.conflicts; audit.pathOwners = partition.pathOwners;
    audit.deferred = partition.deferred; audit.rejected = rejected.map(step => step.id);
    merged = partition.accepted.length ? mergeParallelChanges(working, partition.accepted) : working;
    const policy = loadPolicy(base), checks = applyExceptions(introducedFindings(base, merged, policy).findings, policy);
    if (checks.findings.some(finding => finding.severity === 'error'))
      throw new Error('Parallel merge violates trusted repository policy.');
  } catch (error) {
    state.parallelBatch = undefined;
    for (const step of steps) Object.assign(state.stepStates![step.id]!, {
      status: 'rejected', reason: String(error), updatedAt: new Date().toISOString() });
    syncStepStates(state);
    audit.status = 'failed'; audit.reason = String(error); audit.rejected = steps.map(step => step.id);
    audit.deferred = []; audit.pathOwners = {};
    audit.updatedAt = new Date().toISOString();
    state.status = 'needs_attention'; state.notes.push(String(error)); await save(state, d); return undefined;
  }
  if (!partition.accepted.length) {
    state.parallelBatch = undefined;
    for (const step of rejected) Object.assign(state.stepStates![step.id]!, {
      status: 'rejected', reportId: reportFor(step).id,
      reason: `${reportFor(step).status}: ${reportFor(step).notes.slice(-3).join(' ')}`,
      updatedAt: new Date().toISOString() });
    syncStepStates(state);
    state.serialReplay = [...(state.serialReplay ?? []), ...retryable.map(step => step.id)];
    audit.status = 'failed'; audit.reason = 'No independently verified branch.'; audit.updatedAt = new Date().toISOString();
    if (terminal.length) {
      state.status = 'needs_attention'; state.notes.push('Parallel wave has no independently verified branch.');
    }
    await save(state, d); return terminal.length ? undefined : working;
  }
  let original, combined;
  try {
    original = await d.runner!.run(working, 'goal-merge-base', signal);
    combined = await d.runner!.run(merged, 'goal-merge', signal);
  } catch (error) {
    if (!signal.aborted) await interrupt('Parallel merge execution interrupted: ' + String(error));
    throw error;
  }
  signal.throwIfAborted();
  if (!passed(original) || !passed(combined) || !preservesTests(original, combined)
    || partition.accepted.some(branch => !preservesTests(reportFor(steps.find(step => step.id === branch.step)!).tests.repaired!, combined))) {
    state.parallelBatch = undefined;
    for (const step of steps) Object.assign(state.stepStates![step.id]!, {
      status: 'rejected', reason: 'Parallel merge failed cumulative verification.', updatedAt: new Date().toISOString() });
    syncStepStates(state);
    audit.status = 'failed'; audit.reason = 'Parallel merge failed cumulative verification.';
    audit.deferred = []; audit.pathOwners = {};
    audit.rejected = steps.map(step => step.id); audit.updatedAt = new Date().toISOString();
    state.status = 'needs_attention'; state.notes.push('Parallel merge failed cumulative verification.');
    await save(state, d); return undefined;
  }
  signal.throwIfAborted();
  if (!await fresh(state, d)) throw new StaleTaskError();
  state.changes = changedPaths(base, merged)
    .map(path => ({ path, content: merged.get(path)! }));
  for (const branch of partition.accepted) {
    const step = steps.find(item => item.id === branch.step)!;
    state.completed.push(step.id);
    Object.assign(state.stepStates![step.id]!, { status: 'completed', reportId: reportFor(step).id,
      reason: undefined, updatedAt: new Date().toISOString() });
  }
  for (const step of rejected) Object.assign(state.stepStates![step.id]!, {
    status: 'rejected', reportId: reportFor(step).id,
    reason: `${reportFor(step).status}: ${reportFor(step).notes.slice(-3).join(' ')}`,
    updatedAt: new Date().toISOString() });
  state.serialReplay = [...(state.serialReplay ?? []), ...partition.deferred, ...retryable.map(step => step.id)];
  state.parallelBatch = undefined; syncStepStates(state);
  audit.accepted = partition.accepted.map(branch => branch.step);
  audit.status = rejected.length || partition.deferred.length ? 'partial' : 'merged';
  audit.reason = rejected.length ? 'Independent branch verification failed; verified siblings retained.'
    : partition.deferred.length ? 'Conflicting branches require execution on the updated snapshot.' : undefined;
  audit.updatedAt = new Date().toISOString();
  if (terminal.length) {
    state.status = 'needs_attention'; state.notes.push(`Parallel wave isolated failed steps: ${rejected.map(step => step.id).join(', ')}.`);
  }
  await save(state, d);
  if (terminal.length) return undefined;
  return merged;
}
function goalControl(id: string, d: IterationDependencies, timeout: number) {
  const pause = new AbortController();
  const signal = AbortSignal.any([d.signal, pause.signal, AbortSignal.timeout(timeout)]);
  let checking = false;
  const interval = setInterval(() => {
    if (checking) return; checking = true;
    void d.goals.paused(id).then(value => { if (value) pause.abort(new Error('Goal paused.')); })
      .catch(error => pause.abort(error)).finally(() => { checking = false; });
  }, 250);
  return { signal, stop: () => clearInterval(interval) };
}
export async function fresh(state: GoalState, d: IterationDependencies): Promise<boolean> {
  if ((await d.github.target(state.branch)).sha !== state.sha) return false;
  if (state.spec.issue) {
    const issue = await d.github.issue(state.spec.issue);
    if (issue.pull_request || issue.state !== 'open' || issueDigest(issue) !== state.issueDigest) return false;
    if (state.queued) {
      const policy = d.config.iteration?.queue, candidate = issue as typeof issue & { user?: { login: string }; labels?: { name: string }[] };
      if (!policy || !policy.trustedAuthors.includes(candidate.user?.login ?? '') || !policy.labels.every(l => candidate.labels?.some(v => v.name === l))) return false;
    }
  }
  return true;
}
async function snapshot(state: GoalState, d: IterationDependencies): Promise<Snapshot> {
  const cache = resolve(d.config.dataDir, 'git-cache'); await d.repository.prepare(cache);
  await d.repository.fetch(cache, state.repository, state.sha, state.sha, d.signal);
  return d.repository.snapshot(cache, state.sha, d.signal);
}
/** Reserve an entire agent execution before starting it; a crash never restores unknown usage. */
async function reserve(state: GoalState, d: IterationDependencies) {
  const limits = enabled(d), budget = d.config.agent;
  if (state.calls + budget.maxCalls > limits.maxCalls || state.tokens + budget.maxTokens > limits.maxTokens) throw new Error('Goal model budget exhausted; unused crash reservations are not refunded.');
  state.calls += budget.maxCalls; state.tokens += budget.maxTokens; await save(state, d);
  d.agent!.resetBudget?.();
  return async () => {
    const usage = d.agent!.usage?.();
    if (usage) {
      state.calls += usage.calls - budget.maxCalls;
      state.tokens += (usage.complete === false ? Math.max(budget.maxTokens, usage.tokens) : usage.tokens) - budget.maxTokens;
    }
    await save(state, d);
  };
}
async function design(state: GoalState, base: Snapshot, d: IterationDependencies, signal: AbortSignal) {
  const limits = enabled(d), settle = await reserve(state, d);
  const evidence = { goal: state.spec, maxSteps: limits.maxSteps, previousPlan: state.steps,
    completed: state.completed, feedback: state.notes.slice(-5) };
  const handoff: AgentHandoff = { id: handoffDigest([state.id, 'planner', evidence, state.handoffs?.length ?? 0]),
    role: 'planner', action: 'design', status: 'running', inputDigest: handoffDigest(evidence), at: new Date().toISOString() };
  state.handoffs ??= []; state.handoffs.push(handoff); await save(state, d);
  try {
    const memories = (await d.goals.experiences()).filter(e => e.repository === state.repository && e.sha === state.sha && e.configHash === state.configHash).slice(-5);
    const planner = roleAgent(d.agent!, 'planner');
    if (!planner.design) throw new Error('Planner role does not support goal design.');
    const plan = await planner.design(base, JSON.stringify({ goal: state.spec, maxSteps: limits.maxSteps,
      previousPlan: state.steps, completed: state.completed, feedback: state.notes.slice(-5), experiences: memories }), signal);
    handoff.status = 'completed'; handoff.outputDigest = handoffDigest(plan); handoff.summary = plan.summary.slice(0, 1000);
    let steps;
    try { steps = validateSteps(plan.steps ?? [], state.spec, limits.maxSteps); }
    catch (error) { handoff.status = 'rejected'; throw error; }
    for (const id of state.completed) if (JSON.stringify(steps.find(s => s.id === id)) !== JSON.stringify(state.steps.find(s => s.id === id))) throw new Error('Replanning cannot change completed work.');
    state.steps = steps; state.serialReplay = undefined; state.status = 'planned';
    syncStepStates(state);
  } catch (error) {
    if (handoff.status !== 'rejected') { handoff.status = 'failed'; handoff.summary = String(error).slice(0, 1000); }
    throw error;
  } finally { await settle(); }
}
export async function createGoal(raw: unknown, d: IterationDependencies,
  metadata: { candidateId?: string; evaluationRunId?: string; expectedSha?: string;
    expectedIssueDigest?: string } = {}): Promise<GoalState> {
  const limits = enabled(d), spec = goalSpecSchema.parse(raw), target = await d.github.target(spec.branch);
  if (metadata.expectedSha && target.sha !== metadata.expectedSha) throw new Error('Goal target changed before creation.');
  let digest: string | undefined;
  if (spec.issue) {
    const issue = await d.github.issue(spec.issue);
    if (issue.pull_request || issue.state !== 'open') throw new Error('Goal requires an open Issue.');
    digest = issueDigest(issue);
    if (metadata.expectedIssueDigest && digest !== metadata.expectedIssueDigest)
      throw new Error('Goal Issue changed before creation.');
    if (metadata.candidateId) {
      const queue = d.config.iteration?.queue;
      const source = issue as typeof issue & { user?: { login: string }; labels?: { name: string }[] };
      if (!queue || !queue.trustedAuthors.includes(source.user?.login ?? '')
        || !queue.labels.every(label => source.labels?.some(item => item.name === label)))
        throw new Error('Goal Issue lost queue authorization before creation.');
    }
  }
  const state: GoalState = { schemaVersion: 1, id: taskId([d.config.repository, target.sha, spec, randomUUID()]),
    repository: d.config.repository, spec, configHash: taskId(d.config), branch: target.branch, sha: target.sha,
    issueDigest: digest, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'planned',
    steps: [], completed: [], changes: [], reports: [], rounds: 0, calls: 0, tokens: 0, elapsedMs: 0, notes: [],
    candidateId: metadata.candidateId, evaluationRunId: metadata.evaluationRunId };
  await save(state, d);
  const start = Date.now();
  state.activeSince = new Date(start).toISOString(); await save(state, d);
  const control = goalControl(state.id, d, limits.timeoutSeconds * 1000), signal = control.signal;
  try {
    await design(state, await snapshot(state, { ...d, signal }), d, signal);
    signal.throwIfAborted();
    if (await d.goals.paused(state.id)) state.status = 'paused';
    else if (!await fresh(state, d)) state.status = 'stale';
  }
  catch (error) { state.status = signal.aborted ? 'paused' : 'needs_attention'; state.notes.push(String(error)); }
  finally { control.stop(); }
  state.activeSince = undefined; state.elapsedMs += Date.now() - start; await save(state, d); return state;
}
export async function loadGoal(id: string, d: IterationDependencies) {
  const state = await d.goals.read(id);
  if (!state || state.repository !== d.config.repository) throw new Error('Goal not found in this repository.');
  if (state.configHash !== taskId(d.config)) throw new Error('Goal configuration changed; create a new goal to preserve prior evidence.');
  return state;
}
export async function runGoal(id: string, d: IterationDependencies, replan = false): Promise<GoalState> {
  const limits = enabled(d), state = await loadGoal(id, d);
  await d.goals.unpause(id);
  if (state.publication) {
    const published = await d.store.read(state.publication);
    if (published?.status === 'published' && published.goal?.id === state.id && published.repository === state.repository && published.pullRequestUrl) {
      state.status = 'published'; state.pullRequestUrl = published.pullRequestUrl; state.activeSince = undefined;
      await save(state, d); return state;
    }
  }
  if (['published', 'stale'].includes(state.status)) return state;
  if (state.activeSince) { state.elapsedMs += Math.max(0, Date.now() - Date.parse(state.activeSince)); state.activeSince = undefined; await save(state, d); }
  if (state.elapsedMs >= limits.timeoutSeconds * 1000) throw new Error('Goal time budget exhausted.');
  const remaining = limits.timeoutSeconds * 1000 - state.elapsedMs, start = Date.now();
  // Downtime after an unclean exit counts toward the deadline on resume.
  state.activeSince = new Date(start).toISOString(); await save(state, d);
  const control = goalControl(id, d, remaining), signal = control.signal;
  try {
    if (!await fresh(state, d)) { state.status = 'stale'; return state; }
    await withFreshness(async controlled => {
      const base = await snapshot(state, { ...d, signal: controlled });
      let working = state.changes.length ? applyChanges(base, state.changes) : base;
      if (replan) { state.parallelBatch = undefined; state.serialReplay = undefined; await save(state, d); }
      if (replan || !state.steps.length) await design(state, working, d, controlled);
      state.status = 'running'; await save(state, d);
      while (state.completed.length < state.steps.length) {
        controlled.throwIfAborted();
        if (await d.goals.paused(id)) throw new Error('Goal paused.');
        const ready = state.steps.filter(candidate => !state.completed.includes(candidate.id)
          && candidate.dependsOn.every(parent => state.completed.includes(parent)));
        const capacity = parallelCapacity(limits.collaboration, d.config.runner);
        if (state.parallelBatch || !state.serialReplay?.length && !state.active && capacity > 1 && ready.length > 1) {
          const merged = await parallelWave(state, base, working, d, controlled);
          if (!merged) return;
          working = merged; continue;
        }
        const step = state.serialReplay?.length
          ? ready.find(candidate => candidate.id === state.serialReplay![0])
          : ready[0];
        if (!step) { syncStepStates(state); throw new Error('No executable goal step.'); }
        if (state.serialReplay?.[0] === step.id) {
          const previousRef = [...state.reports].reverse().find(reference => reference.startsWith(step.id + ':'));
          const previous = previousRef ? await d.store.read(previousRef.split(':')[1]!) : undefined;
          const wait = previous?.status === 'error' && previous.retryable ? Date.parse(previous.retryAfter ?? '') - Date.now() : 0;
          if (Number.isFinite(wait) && wait > 30000) {
            state.status = 'needs_attention'; state.notes.push(`Step ${step.id} retry is available after ${previous!.retryAfter}.`);
            await save(state, d); return;
          }
          if (Number.isFinite(wait) && wait > 0) await pause(wait, controlled);
        }
        const criteria = state.spec.acceptance.filter(a => step.acceptanceIds.includes(a.id)).map(a => a.text);
        const previousPatches: string[] = [], priorFeedback: string[] = [];
        for (const reference of state.reports) {
          const previous = await d.store.read(reference.split(':')[1]!);
          if (previous) { previousPatches.push(...previous.repairs.filter(r => !r.accepted).map(r => patchDigest(r.changes))); priorFeedback.push(...previous.notes.slice(-2)); }
        }
        const runKey = state.active?.step === step.id ? state.active.runKey : taskId([id, step, state.rounds, state.changes]);
        const input: RunInput = { base: working, head: working, baseSha: state.sha, headSha: state.sha, runKey, keepBudget: true,
            description: `${state.spec.mode === 'feature' ? 'Feature implementation' : 'Bug reproduction'}: ${state.spec.objective}\nStep: ${step.title}\nAcceptance:\n${criteria.join('\n')}\nAllowed paths: ${state.spec.allowedPaths.join(', ')}\nPrevious verification feedback (untrusted evidence): ${priorFeedback.join('\n').slice(-12000)}`,
            previousPatches,
            implementation: { mode: state.spec.mode, acceptance: criteria, allowedPaths: state.spec.allowedPaths }
          };
        const pipelineConfig = { ...d.config, publish: false };
        let report = state.active ? await d.store.read(pipelineId(input, pipelineConfig)) : undefined;
        if (!report || ['running', 'cancelled', 'error'].includes(report.status)) {
          if (state.rounds >= limits.maxRounds * limits.maxSteps) throw new Error('Goal iteration limit reached.');
          const count = (criterion: string) => state.criterionAttempts && Object.hasOwn(state.criterionAttempts, criterion) ? state.criterionAttempts[criterion]! : 0;
          if (step.acceptanceIds.some(criterion => count(criterion) >= limits.maxRounds)) throw new Error('Acceptance retry limit reached.');
          state.criterionAttempts = Object.fromEntries(state.spec.acceptance.map(a => [a.id, count(a.id) + (step.acceptanceIds.includes(a.id) ? 1 : 0)]));
          state.active = { step: step.id, runKey }; state.rounds++;
          syncStepStates(state);
          const execution = state.stepStates![step.id]!; execution.attempts++; execution.updatedAt = new Date().toISOString();
          await save(state, d);
          const settle = await reserve(state, d);
          try { report = await runPipeline(input, pipelineConfig, d.store, d.runner, d.agent, controlled); }
          finally { await settle(); }
        }
        controlled.throwIfAborted();
        const reference = step.id + ':' + report.id;
        if (!state.reports.includes(reference)) state.reports.push(reference);
        state.active = undefined;
        if (report.status !== 'verified' || !report.tests.repaired || !passed(report.tests.repaired)) {
          syncStepStates(state);
          Object.assign(state.stepStates![step.id]!, { status: 'rejected', reportId: report.id,
            reason: `${report.status}: ${report.notes.slice(-3).join(' ')}`, updatedAt: new Date().toISOString() });
          syncStepStates(state);
          state.notes.push(`Step ${step.id}: ${report.status}. ${report.notes.slice(-3).join(' ')}`);
          if (state.serialReplay?.[0] === step.id) state.serialReplay.shift();
          state.status = 'needs_attention'; await save(state, d);
          const retryableEvidence = report.status === 'needs_attention' && report.tests.repaired?.status === 'failed'
            && report.tests.repaired.structured && report.testStability?.status === 'stable'
            && !report.repairs.some(r => r.reason?.includes('Repeated patch'));
          if (retryableEvidence && state.reports.filter(r => r.startsWith(step.id + ':')).length < limits.maxRounds) {
            await design(state, working, d, controlled);
            continue;
          }
          return;
        }
        working = applyChanges(working, report.changes);
        state.changes = changedPaths(base, working).map(path => ({ path, content: working.get(path)! }));
        state.completed.push(step.id); syncStepStates(state);
        if (state.serialReplay?.[0] === step.id) state.serialReplay.shift();
        Object.assign(state.stepStates![step.id]!, { status: 'completed', reportId: report.id, reason: undefined,
          updatedAt: new Date().toISOString() });
        await save(state, d);
      }
      const final = await d.runner!.run(working, 'goal-final', controlled);
      const originals = await d.runner!.run(base, 'goal-original', controlled);
      controlled.throwIfAborted();
      if (!passed(final) || !passed(originals) || !preservesTests(originals, final)) throw new Error('Final cumulative verification failed.');
      for (const step of state.completed) {
        let evidence: Report | undefined;
        for (const ref of state.reports.filter(r => r.startsWith(step + ':'))) {
          const report = await d.store.read(ref.split(':')[1]!);
          if (report?.status === 'verified' && report.tests.repaired && passed(report.tests.repaired)) evidence = report;
        }
        if (!evidence?.tests.repaired) throw new Error('Completed step evidence is missing or no longer verified: ' + step);
        if (!preservesTests(evidence.tests.repaired, final)) throw new Error('Final verification lost a completed step test.');
      }
      if (d.config.iteration!.preview) {
        if (!d.previewRunner) throw new Error('Preview runner missing.');
        const candidate = await d.previewRunner.run(working, 'preview-candidate-health', controlled);
        const rollback = await d.previewRunner.run(base, 'preview-rollback-health', controlled);
        state.preview = { candidate, rollback }; await save(state, d);
        if (!passed(candidate) || !passed(rollback) || !preservesTests(rollback, candidate)) throw new Error('Preview health or rollback rehearsal failed.');
      }
      const report: Report = { schemaVersion: 2, id: state.publication ?? taskId(['goal-publication', state.id]), repository: state.repository,
        goal: { id: state.id, title: state.spec.title, branch: state.branch, issue: state.spec.issue, issueDigest: state.issueDigest,
          queue: state.queued && d.config.iteration?.queue ? { labels: d.config.iteration.queue.labels, trustedAuthors: d.config.iteration.queue.trustedAuthors } : undefined },
        base: state.sha, head: state.sha, descriptionHash: taskId(state.spec), status: 'verified', findings: [], historical: [], suppressed: [],
        semantic: 'completed', tests: { base: originals, head: originals, repaired: final }, evidence: [{ phase: 'goal-final', attempt: 0, result: final }],
        repairs: [], changes: state.changes, attempts: state.rounds, notes: [
          ...state.spec.acceptance.map(a => `${a.id}: ${a.text}`), ...state.reports.map(id => 'Step evidence: ' + id),
          `Goal budget ledger (includes unknown-use reservations): ${state.calls} calls, ${state.tokens} tokens; rounds: ${state.rounds}.`
        ],
        createdAt: state.createdAt, executions: 1, retryable: false };
      controlled.throwIfAborted();
      if (!await fresh(state, d)) throw new StaleTaskError();
      state.publication = report.id; state.status = 'verified'; await save(state, d);
      const prior = await d.store.read(report.id);
      if (prior?.publication) report.publication = prior.publication;
      if (prior?.status === 'published') { report.status = 'published'; report.pullRequestUrl = prior.pullRequestUrl; }
      await d.store.save(report); await finishReport(report, d.config, d.store, d.github, controlled);
      state.pullRequestUrl = report.pullRequestUrl;
      state.status = report.status === 'published' ? 'published' : report.status === 'stale' ? 'stale' : 'verified';
    }, () => fresh(state, d), d.config.freshnessSeconds * 1000, signal);
  } catch (error) {
    state.status = error instanceof StaleTaskError ? 'stale' : signal.aborted || await d.goals.paused(id) ? 'paused' : 'needs_attention'; state.notes.push(String(error));
  } finally {
    control.stop(); state.elapsedMs += Date.now() - start; state.activeSince = undefined; await save(state, d);
    await d.goals.remember({ id: state.id, goalId: state.id, repository: state.repository, sha: state.sha, configHash: state.configHash,
      outcome: state.status, completed: state.completed, reportIds: state.reports, notes: state.notes.slice(-10), createdAt: state.updatedAt });
  }
  return state;
}
