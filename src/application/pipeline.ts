import type { Config } from '../domain/config.js';
import type { Answer } from '../domain/agent-answer.js';
import { handoffDigest, type AgentHandoff, type AgentRole } from '../domain/collaboration.js';
import { descriptionHash, pipelineId } from '../domain/identity.js';
import { applyExceptions, introducedFindings, loadPolicy, partitionFindings } from '../domain/policy.js';
import { applyChanges, isTest, semanticFindings, validatePlan } from '../domain/repair.js';
import { reproduced } from '../domain/reproduction.js';
import { patchDigest, withinScope } from '../domain/iteration.js';
import { changedPaths } from '../domain/snapshot.js';
import type { RunInput } from '../domain/task.js';
import { assessPlan } from '../domain/test-assessment.js';
import { notRun, passed, preservesTests } from '../domain/test-evidence.js';
import { assessStability, diagnose } from '../domain/test-diagnosis.js';
import type { Report, Snapshot, TestResult } from '../domain/types.js';
import { roleAgent, type Agent } from '../ports/agent.js';
import { type Runner } from '../ports/runner.js';
import { type Store } from '../ports/store.js';
import { pause, RetryableError, StaleTaskError, throwIfAborted } from '../shared/control.js';
import { TaskCancelledError, withTaskCancellation } from './task-control.js';

export async function runPipeline(input: RunInput, config: Config, store: Store, runner?: Runner, agent?: Agent, parent?: AbortSignal): Promise<Report> {
  return withTaskCancellation(store, pipelineId(input, config), signal => executePipeline(input, config, store, runner, agent, signal), parent);
}
async function executePipeline(input: RunInput, config: Config, store: Store, runner?: Runner, agent?: Agent, parent?: AbortSignal): Promise<Report> {
  const description = input.pr ? `${input.pr.title}\n${input.pr.body ?? ''}` : input.description ?? '';
  const hash = descriptionHash(input.pr, description);
  const id = pipelineId(input, config);
  const previous = await store.read(id);
  if (previous && input.repoPath && !previous.replay) {
    previous.replay = { repoPath: input.repoPath, description, pr: input.pr, issue: input.issue, runKey: input.runKey };
    await store.save(previous);
  }
  if (previous && parent?.reason instanceof TaskCancelledError) {
    if (previous.status !== 'published') { previous.status = 'cancelled'; await store.save(previous); }
    return previous;
  }
  if (previous && ['running', 'cancelled'].includes(previous.status) && previous.executions >= config.retry.maxTaskExecutions) {
    previous.status = 'error'; previous.retryable = false;
    previous.notes.push('Task execution limit reached after interruption.'); await store.save(previous); return previous;
  }
  if (previous && previous.status !== 'running' && previous.status !== 'cancelled'
    && !(previous.status === 'error' && previous.retryable && previous.executions < config.retry.maxTaskExecutions
      && Date.parse(previous.retryAfter ?? '') <= Date.now())) return previous;
  if (previous) await store.archive(previous);
  const report: Report = { schemaVersion: 2, id, repository: config.repository, pr: input.pr?.number, base: input.baseSha, head: input.headSha,
    descriptionHash: hash, status: 'running', findings: [], historical: [], suppressed: [], semantic: 'not_run',
    tests: { base: notRun(), head: notRun() }, evidence: [], repairs: [], changes: [], attempts: 0, notes: [],
    createdAt: new Date().toISOString(), executions: (previous?.executions ?? 0) + 1, retryable: false,
    issue: input.issue,
    replay: input.repoPath ? { repoPath: input.repoPath, description, pr: input.pr, issue: input.issue, runKey: input.runKey } : undefined,
    rerunOf: input.rerunOf };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Task time budget exceeded.')), config.taskTimeoutSeconds * 1000);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  if (!input.keepBudget) agent?.resetBudget?.();
  const save = async () => { report.agentUsage = agent?.usage?.(); await store.save(report); };
  const invoke = async (role: AgentRole, action: AgentHandoff['action'], evidence: unknown,
    operation: (selected: Agent) => Promise<Answer>) => {
    const handoff: AgentHandoff = { id: handoffDigest([id, role, action, evidence, report.handoffs?.length ?? 0]),
      role, action, status: 'running', inputDigest: handoffDigest(evidence), at: new Date().toISOString() };
    report.handoffs ??= []; report.handoffs.push(handoff); await save();
    try {
      const answer = await operation(roleAgent(agent!, role));
      handoff.status = 'completed'; handoff.outputDigest = handoffDigest(answer);
      handoff.summary = answer.summary.slice(0, 1000); await save();
      return { answer, handoff };
    } catch (error) {
      handoff.status = 'failed'; handoff.summary = String(error).slice(0, 1000); await save(); throw error;
    }
  };
  const run = async (files: Snapshot, phase: string, attempt = 0): Promise<TestResult> => {
    throwIfAborted(signal);
    const limit = config.runner?.environmentAttempts ?? 2;
    for (let execution = 1; ; execution++) {
      const result = diagnose(await runner!.run(files, phase, signal));
      throwIfAborted(signal);
      report.evidence.push({ phase, attempt, execution, result }); await save();
      if (result.status !== 'error' || result.failure?.kind !== 'environment' || !result.failure.retryable || execution >= limit) return result;
      await pause(Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** (execution - 1)), signal);
    }
  };
  try {
    await save(); throwIfAborted(signal);
    if (input.issue && (input.pr || input.baseSha !== input.headSha || changedPaths(input.base, input.head).length)) throw new Error('Issue reproduction requires one pinned target snapshot.');
    if (input.issue && (!agent || !runner || !config.agent.repair)) throw new Error('Issue reproduction requires an agent, runner and enabled repairs.');
    const implementing = !!input.implementation;
    const policy = loadPolicy(input.base), paths = input.issue || implementing ? [...input.head.keys()] : changedPaths(input.base, input.head);
    Object.assign(report, introducedFindings(input.base, input.head, policy));
    const policyChanged = changedPaths(input.base, input.head).some(path => /(^|\/)AGENTS\.md$/.test(path) || path === '.repopilot/policy.json');
    if (policyChanged) report.notes.push('Policy changes require maintainer review; using base policy.');
    let baselineSemantic: ReturnType<typeof semanticFindings> = [];
    if (agent) {
      const baselineReview = await invoke('reviewer', 'review', { phase: 'baseline', base: input.baseSha, paths, descriptionHash: hash },
        selected => selected.review(input.base, input.base, description, signal, paths));
      baselineSemantic = semanticFindings(baselineReview.answer, input.base, input.base, paths);
      const currentReview = await invoke('reviewer', 'review', { phase: 'candidate', base: input.baseSha, head: input.headSha, paths, descriptionHash: hash },
        selected => selected.review(input.base, input.head, description, signal, paths));
      const current = semanticFindings(currentReview.answer, input.base, input.head, paths);
      const semantic = partitionFindings(baselineSemantic, current, input.base, input.head);
      if (semantic.findings.some(f => f.severity === 'error')) currentReview.handoff.status = 'rejected';
      report.findings.push(...semantic.findings); report.historical.push(...semantic.historical); report.semantic = 'completed';
    }
    Object.assign(report, applyExceptions(report.findings, policy));
    if (runner) { report.tests.base = await run(input.base, 'base'); report.tests.head = await run(input.head, 'head'); }
    let working = input.head, red = report.tests.head, baseline = report.tests.base;
    const issueBaseline = !(input.issue || implementing) || (passed(red) && preservesTests(baseline, red) && preservesTests(red, baseline));
    let eligible = passed(baseline) && issueBaseline;
    if (agent && runner && !policyChanged && issueBaseline && passed(baseline) && ['passed', 'failed'].includes(red.status)) {
      const planned = await invoke('tester', 'test_plan', { base: input.baseSha, head: input.headSha,
        descriptionHash: hash, intent: input.implementation?.mode },
      selected => selected.plan(input.base, input.head, description, signal, input.implementation?.mode));
      try { report.plan = validatePlan(planned.answer, input.head, description); }
      catch (error) { planned.handoff.status = 'rejected'; throw error; }
      if (input.implementation) {
        const spec = input.implementation;
        if (report.plan.tests.some(t => !withinScope(t.path, spec.allowedPaths))
          || report.plan.scenarios.some(s => s.kind !== (spec.mode === 'feature' ? 'new_behavior' : 'regression') || !s.requirementQuote || !spec.acceptance.includes(s.requirementQuote))
          || spec.acceptance.some(text => !report.plan!.scenarios.some(s => s.requirementQuote === text))) {
          planned.handoff.status = 'rejected'; throw new Error('Implementation tests must cover every acceptance criterion verbatim within the allowed paths.');
        }
      }
      if (input.issue && report.plan.scenarios.some(s => s.kind !== 'regression' || !s.requirementQuote || s.requirementQuote.trim().length < 8
        || !description.includes(s.requirementQuote))) {
        planned.handoff.status = 'rejected'; throw new Error('Issue reproduction requires regression scenarios with exact Issue requirement quotes.');
      }
      working = applyChanges(input.head, report.plan.tests);
      baseline = await run(applyChanges(input.base, report.plan.tests), 'planned-base');
      red = await run(working, 'planned-head');
      for (const test of report.plan.tests) {
        const cases = red.cases.filter(c => c.file === test.path);
        if (!cases.length || cases.some(c => c.status === 'skipped')) throw new Error('Generated tests were not fully executed: ' + test.path);
      }
      if (input.issue || implementing) {
        const alreadySatisfied = input.implementation?.mode === 'feature' && passed(baseline) && passed(red)
          && preservesTests(report.tests.base, baseline) && preservesTests(report.tests.head, red)
          && preservesTests(baseline, red) && preservesTests(red, baseline);
        eligible = alreadySatisfied || reproduced(report.plan, report.tests.base, baseline, red);
        report.notes.push(eligible ? 'Requested behavior demonstrated by stable generated test failures on the pinned target.' : 'Missing behavior was not reproducibly demonstrated; repair blocked.');
      } else {
        report.testAssessment = assessPlan(report.plan, report.tests.base, report.tests.head, baseline, red);
        eligible = report.testAssessment.eligible;
        report.notes.push(...report.testAssessment.reasons);
      }
    }
    const regression = eligible && red.status === 'failed' && red.structured;
    if (input.reproductionOnly) {
      if (!input.issue || !input.implementation || input.implementation.mode !== 'bugfix')
        throw new Error('Reproduction-only execution requires a scoped bugfix Issue.');
      if (regression) report.testStability = assessStability(red, await run(working, 'repeat-head'));
      const reproducedFailure = regression && report.testStability?.status === 'stable';
      report.reproduction = { reproduced: !!reproducedFailure,
        reason: reproducedFailure ? 'Pinned Issue failure reproduced with stable generated test identities.'
          : 'Pinned Issue failure was not demonstrated with stable structured evidence.' };
      report.status = 'needs_attention'; report.notes.push(report.reproduction.reason);
      await save(); return report;
    }
    if (!passed(report.tests.base)) report.notes.push('Base tests already fail or lack structured passing evidence; automatic repair is blocked.');
    if (!eligible) report.notes.push('Test evidence requires maintainer review.');
    const preservedBase = preservesTests(report.tests.base, report.tests.head);
    if (passed(report.tests.head) && !preservedBase) report.notes.push('Head removed or skipped baseline tests; maintainer review required.');
    report.status = !report.findings.length && passed(red) && eligible && preservedBase && !policyChanged ? 'passed' : 'needs_attention';
    if (implementing && agent && report.status === 'passed' && report.plan) {
      const checks = applyExceptions(introducedFindings(input.base, working, policy).findings, policy);
      const reviewedAnswer = await invoke('reviewer', 'review', { phase: 'acceptance-only', base: input.baseSha,
        changes: changedPaths(input.base, working) }, selected => selected.review(input.base, working, description, signal));
      const reviewed = semanticFindings(reviewedAnswer.answer, input.base, working);
      const semantic = partitionFindings(baselineSemantic, reviewed, input.base, working);
      if (checks.findings.some(f => f.severity === 'error') || applyExceptions(semantic.findings, policy).findings.some(f => f.severity === 'error')) {
        reviewedAnswer.handoff.status = 'rejected';
        report.status = 'needs_attention'; report.notes.push('Acceptance tests pass, but generated changes require policy review.');
      } else {
        report.status = 'verified'; report.tests.repaired = red; report.changes = report.plan.tests;
        report.notes.push('Acceptance criteria already pass; verified new tests without unnecessary production changes.');
      }
    }
    if (agent && runner && config.agent.repair && !policyChanged && eligible
      && (regression || (passed(red) && report.findings.some(f => f.severity === 'error')))) {
      if (regression) report.testStability = assessStability(red, await run(working, 'repeat-head'));
      if (regression && report.testStability?.status !== 'stable') {
        report.notes.push(report.testStability!.reason);
      } else {
        let feedback = '';
        const attempted = new Set<string>(input.previousPatches);
        for (let attempt = 1; attempt <= config.agent.maxAttempts; attempt++) {
          throwIfAborted(signal); report.attempts = attempt;
          const repaired = await invoke('developer', 'repair', { attempt, base: input.baseSha, head: input.headSha,
            findings: report.findings, failedTests: red, plan: report.plan, previousAttempt: feedback },
          selected => selected.repair(input.base, working, JSON.stringify({ description,
            findings: report.findings, failedTests: red, plan: report.plan, previousAttempt: feedback }), signal, input.implementation?.mode));
          const answer = repaired.answer;
          const record = { number: attempt, changes: answer.changes, summary: answer.summary, accepted: false, reason: '' };
          report.repairs.push(record);
          const digest = patchDigest(answer.changes);
          if (attempted.has(digest)) { repaired.handoff.status = 'rejected'; record.reason = 'Repeated patch without progress; stopped.'; report.notes.push(record.reason); break; }
          attempted.add(digest);
          try {
            if (input.implementation && answer.changes.some(c => !withinScope(c.path, input.implementation!.allowedPaths))) throw new Error('Repair exceeds the goal allowed paths.');
            if (answer.changes.some(c => isTest(c.path))) throw new Error('Repair must preserve frozen tests.');
            const candidate = applyChanges(working, answer.changes);
            if (!changedPaths(working, candidate).length) throw new Error('Repair did not change source.');
            const checks = applyExceptions(introducedFindings(input.base, candidate, policy).findings, policy);
            if (checks.findings.some(f => f.severity === 'error')) throw new Error('Repair still violates static policy.');
            report.tests.repaired = await run(candidate, 'repair', attempt);
            if (report.tests.repaired.status === 'error' || report.tests.repaired.status === 'not_run') {
              record.reason = 'Repair verification is inconclusive; no further source changes requested.';
              report.notes.push(record.reason); break;
            }
            if (!passed(report.tests.repaired) || !preservesTests(red, report.tests.repaired)
              || !preservesTests(report.tests.head, report.tests.repaired)
              || !preservesTests(report.tests.base, report.tests.repaired)) throw new Error('Repair did not pass the same test identities.');
            const candidateReview = await invoke('reviewer', 'review', { phase: 'repair', attempt,
              base: input.baseSha, changes: changedPaths(input.base, candidate) },
            selected => selected.review(input.base, candidate, description, signal));
            const reviewed = semanticFindings(candidateReview.answer,
              input.base, candidate);
            const semantic = partitionFindings(baselineSemantic, reviewed, input.base, candidate);
            if (applyExceptions(semantic.findings, policy).findings.some(f => f.severity === 'error')) {
              candidateReview.handoff.status = 'rejected'; throw new Error('Repair has unresolved semantic findings.');
            }
            report.changes = changedPaths(input.head, candidate).map(path => ({ path, content: candidate.get(path)! }));
            report.status = 'verified'; record.accepted = true; break;
          } catch (error) {
            throwIfAborted(signal);
            if (error instanceof RetryableError) throw error;
            repaired.handoff.status = 'rejected';
            feedback = JSON.stringify({ reason: String(error), result: report.tests.repaired, previousChanges: answer.changes }).slice(0, 60000); record.reason = String(error);
            report.notes.push('Attempt ' + attempt + ': ' + feedback);
          }
          await save();
        }
      }
    }
    throwIfAborted(signal);
  } catch (error) {
    report.status = signal.reason instanceof StaleTaskError ? 'stale' : parent?.aborted ? 'cancelled' : 'error';
    report.retryable = error instanceof RetryableError;
    if (error instanceof RetryableError) report.retryAfter = new Date(Date.now() + Math.max(error.retryAfterMs,
      Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** (report.executions - 1)))).toISOString();
    report.notes.push(String(error));
  } finally { clearTimeout(timer); }
  await save(); return report;
}
