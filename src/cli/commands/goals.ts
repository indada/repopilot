import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { discover, maintainGoal, trackGoal, type AutomationDependencies } from '../../application/automation.js';
import { processIssueCandidates } from '../../application/candidates.js';
import { compareEvaluationProfiles, evaluateGoals } from '../../application/evaluation.js';
import { replayEvaluationSuite } from '../../application/evaluation-replay.js';
import { createGoal, runGoal } from '../../application/iteration.js';
import type { Config } from '../../domain/config.js';
import { strategyGateSchema, type GoalState } from '../../domain/iteration.js';
import { taskId } from '../../domain/identity.js';
import type { IterationStore } from '../../ports/iteration.js';
import type { CandidateStore } from '../../ports/candidate.js';
import type { CliValues } from '../args.js';
import type { Output } from '../runtime.js';

const statuses: GoalState['status'][] = ['planned', 'running', 'paused', 'needs_attention', 'verified', 'published', 'stale'];
const emit = (output: Output, value: unknown) => output.write(JSON.stringify(value, null, 2));
function page(values: CliValues) {
  const limit = Number(values.limit ?? 20), offset = Number(values.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid pagination.');
  return { limit, offset };
}
export function validateGoalCommand(command: string, action: string | undefined, id: string | undefined, values: CliValues) {
  if (command === 'goals') {
    if (!['plan', 'run', 'replan', 'maintain', 'track', 'list', 'show', 'graph', 'pause'].includes(action ?? '')) throw new Error('Unknown goals action.');
    if (action === 'plan' && !values.spec) throw new Error('Planning requires --spec GOAL_JSON.');
    if (!['plan', 'list'].includes(action!) && !id) throw new Error('Goal ID is required.');
    if (id && !/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid goal ID.');
  }
  if (command === 'discover' && values.apply && !values.expected) throw new Error('Apply requires --expected PREVIEW_TOKEN from discover.');
  if (command === 'discover' && values.expected && !values.apply) throw new Error('--expected requires --apply.');
  if (command === 'evals') {
    if (action && !['gate', 'replay'].includes(action)) throw new Error('Unknown evals action.');
    for (const [label, value] of [['suite', values.suite], ['profile', values.profile],
      ['baseline', values.baseline], ['candidate', values.candidate]] as const)
      if (value && !/^[a-z][a-z0-9-]{0,39}$/.test(value)) throw new Error(`Invalid evaluation ${label}.`);
    if (action === 'replay' && (!values.spec || !values.profile)) throw new Error('Replay requires --spec SUITE_JSON and --profile PROFILE.');
  }
}
function gateConfig(config: Config, values: CliValues) {
  const configured = config.iteration?.strategyGate;
  if (!configured && (!values.suite || !values.baseline || !values.candidate))
    throw new Error('Evaluation gate requires strategyGate configuration or --suite, --baseline and --candidate.');
  return strategyGateSchema.parse({ ...configured, suite: values.suite ?? configured?.suite,
    baselineProfile: values.baseline ?? configured?.baselineProfile,
    candidateProfile: values.candidate ?? configured?.candidateProfile });
}
/** Inspection and pause requests remain available while another controller holds the execution lock. */
export async function inspectGoals(command: string, action: string | undefined, id: string | undefined, values: CliValues,
  config: Config, goals: IterationStore, output: Output): Promise<boolean | 'ineligible'> {
  if (command === 'experiences') {
    const { limit, offset } = page(values), entries = (await goals.experiences()).filter(e => e.repository === config.repository)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    emit(output, { total: entries.length, offset, experiences: entries.slice(offset, offset + limit) }); return true;
  }
  if (command === 'evals' && action !== 'replay') {
    const entries = (await goals.list()).filter(goal => goal.repository === config.repository);
    if (action === 'gate') {
      const decision = compareEvaluationProfiles(entries, gateConfig(config, values),
        taskId({ ...config, publish: false }));
      emit(output, decision); return decision.eligible ? true : 'ineligible';
    }
    emit(output, evaluateGoals(entries, values.suite));
    return true;
  }
  if (command !== 'goals' || !['list', 'show', 'graph', 'pause'].includes(action ?? '')) return false;
  if (action === 'list') {
    const { limit, offset } = page(values);
    if (values.status && !statuses.includes(values.status as GoalState['status'])) throw new Error('Unknown goal status.');
    const states = (await goals.list()).filter(s => s.repository === config.repository && (!values.status || s.status === values.status));
    const entries = await Promise.all(states.slice(offset, offset + limit).map(async s => ({ id: s.id, title: s.spec.title,
      status: s.status, completed: s.completed.length, steps: s.steps.length,
      blocked: Object.values(s.stepStates ?? {}).filter(step => step.status === 'blocked').length,
      rejected: Object.values(s.stepStates ?? {}).filter(step => step.status === 'rejected').length,
      updatedAt: s.updatedAt, pauseRequested: await goals.paused(s.id) })));
    emit(output, { total: states.length, offset, goals: entries }); return true;
  }
  const state = await goals.read(id!);
  if (!state || state.repository !== config.repository) throw new Error('Goal not found in this repository.');
  if (action === 'pause') { await goals.pause(id!); emit(output, { id, pauseRequested: true }); }
  else if (action === 'graph') emit(output, { id: state.id, status: state.status,
    steps: state.steps.map(step => ({ ...step, execution: state.stepStates?.[step.id] ?? {
      status: state.completed.includes(step.id) ? 'completed' : 'pending', attempts: 0, updatedAt: state.updatedAt } })),
    parallelBatch: state.parallelBatch,
    serialReplay: state.serialReplay ?? [], waveHistory: state.waveHistory ?? [],
    handoffs: state.handoffs ?? [] });
  else emit(output, { ...state, pauseRequested: await goals.paused(id!) });
  return true;
}
export async function executeGoals(command: string, action: string | undefined, id: string | undefined, values: CliValues,
  deps: AutomationDependencies & { candidates?: CandidateStore }, output: Output): Promise<number> {
  if (command === 'evals' && action === 'replay') {
    const result = await replayEvaluationSuite(JSON.parse(await readFile(values.spec!, 'utf8')), values.profile!, deps);
    emit(output, result); return result.cases.some(item => !['verified', 'published'].includes(item.status)) ? 1 : 0;
  }
  if (command === 'discover') { emit(output, await discover(deps, values.apply ? values.expected : undefined)); return 0; }
  if (command === 'iterate') {
    const failedMaintenance = new Set<string>();
    let maintenanceOffset = 0;
    do {
      if (deps.signal.aborted) return 0;
      let queueFailure = false;
      try {
        if (deps.config.iteration?.maintenance || deps.config.iteration?.postMerge) {
          const candidates = (await deps.goals.list()).filter(s => s.repository === deps.config.repository && s.status === 'published'
            && !['healthy', 'regressed', 'closed_unmerged'].includes(s.postMerge?.status ?? '') && !failedMaintenance.has(s.id));
          const limit = deps.config.iteration.queue?.maxPerRun ?? 1;
          const start = candidates.length ? maintenanceOffset % candidates.length : 0;
          const batch = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, limit);
          maintenanceOffset = start + batch.length;
          for (const state of batch) {
            if (deps.signal.aborted) return 0;
            if (await deps.goals.paused(state.id)) continue;
            try {
              let maintain = !!deps.config.iteration?.maintenance;
              if (deps.config.iteration?.postMerge) {
                const outcome = await trackGoal(state.id, deps); emit(output, outcome);
                maintain = maintain && outcome?.status === 'waiting_for_merge';
              }
              if (maintain) emit(output, await maintainGoal(state.id, deps));
            }
            catch (error) {
              if (deps.signal.aborted) return 0;
              failedMaintenance.add(state.id);
              output.error(`Goal ${state.id} follow-up failed; automatic processing stopped for this session: ${String(error)}`);
            }
          }
        }
        if (deps.config.iteration?.queue) {
          if (!deps.candidates) throw new Error('Issue iteration requires a candidate store.');
          let eligible = true, strategyGate;
          if (deps.config.iteration.strategyGate) {
            strategyGate = compareEvaluationProfiles((await deps.goals.list())
              .filter(goal => goal.repository === deps.config.repository), deps.config.iteration.strategyGate,
              taskId({ ...deps.config, publish: false }));
            eligible = strategyGate.eligible;
          }
          const queue = await processIssueCandidates({ ...deps, candidates: deps.candidates }, eligible);
          emit(output, { queue, strategyGate });
          for (const error of queue.errors) output.error(error.error);
          queueFailure = !eligible || queue.errors.length > 0;
        }
        if (!deps.config.iteration?.queue && !deps.config.iteration?.maintenance && !deps.config.iteration?.postMerge) throw new Error('iterate requires iteration.queue or iteration.maintenance, or iteration.postMerge.');
      }
      catch (error) { if (deps.signal.aborted) return 0; throw error; }
      if (values.once) return queueFailure ? 1 : 0;
      try { await delay(deps.config.pollSeconds * 1000, undefined, { signal: deps.signal }); }
      catch (error) { if (deps.signal.aborted) return 0; throw error; }
    } while (!deps.signal.aborted);
    return 0;
  }
  if (action === 'track') { emit(output, await trackGoal(id!, deps)); return 0; }
  if (action === 'maintain') {
    const result = await maintainGoal(id!, deps); emit(output, result);
    return ['needs_attention', 'stale', 'ci_not_reproduced'].includes(result.status) ? 1 : 0;
  }
  const state = action === 'plan' ? await createGoal(JSON.parse(await readFile(values.spec!, 'utf8')), deps)
    : await runGoal(id!, deps, action === 'replan');
  emit(output, state); return ['needs_attention', 'stale', 'paused'].includes(state.status) ? 1 : 0;
}
