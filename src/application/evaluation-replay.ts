import { taskId } from '../domain/identity.js';
import { evaluationSuiteSchema } from '../domain/evaluation.js';
import type { GoalState } from '../domain/iteration.js';
import type { IterationDependencies } from './iteration.js';
import { createGoal, runGoal } from './iteration.js';

/** A replay uses explicit commit pins and never enters the publication path. */
export async function replayEvaluationSuite(raw: unknown, profile: string, d: IterationDependencies) {
  const suite = evaluationSuiteSchema.parse(raw);
  if (suite.repository !== d.config.repository) throw new Error('Evaluation suite targets a different repository.');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(profile)) throw new Error('Invalid evaluation profile.');
  const deps = { ...d, config: { ...d.config, publish: false } };
  const configHash = taskId(deps.config), entries: { case: string; goalId: string; status: GoalState['status'] }[] = [];
  for (const item of suite.cases) {
    d.signal.throwIfAborted();
    const spec = { ...item.spec, branch: item.branch, evaluation: { suite: suite.suite, case: item.id, profile } };
    const replayId = taskId([suite.repository, suite.suite, item.id, profile, item.sha, spec, configHash]);
    const target = await d.github.target(item.branch);
    if (target.branch !== item.branch || target.sha !== item.sha) throw new Error(`Evaluation case ${item.id} no longer matches its pinned branch.`);
    const prior = (await d.goals.list()).filter(goal => goal.repository === suite.repository
      && goal.spec.evaluation?.suite === suite.suite && goal.spec.evaluation.case === item.id
      && goal.spec.evaluation.profile === profile);
    if (prior.length > 1 || prior.some(goal => goal.evaluationRunId !== replayId))
      throw new Error(`Evaluation case ${item.id} already has different evidence for this profile.`);
    let state = prior[0];
    if (!state) state = await createGoal(spec, deps, { evaluationRunId: replayId, expectedSha: item.sha });
    if (state.sha !== item.sha || state.configHash !== configHash || state.evaluationRunId !== replayId)
      throw new Error(`Evaluation case ${item.id} has mismatched pinned evidence.`);
    if (['planned', 'running', 'paused'].includes(state.status)) state = await runGoal(state.id, deps);
    entries.push({ case: item.id, goalId: state.id, status: state.status });
  }
  return { schemaVersion: 1, repository: suite.repository, suite: suite.suite, profile, cases: entries,
    evidenceDigest: taskId(entries) };
}
