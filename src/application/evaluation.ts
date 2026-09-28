import { taskId } from '../domain/identity.js';
import type { GoalState } from '../domain/iteration.js';
import type { IterationConfig } from '../domain/iteration.js';

export interface EvaluationRecord {
  goalId: string;
  suite: string;
  case: string;
  profile: string;
  caseDigest: string;
  configHash: string;
  replayId?: string;
  goalStatus: GoalState['status'];
  outcome: 'healthy' | 'regressed' | 'published' | 'verified' | 'failed';
  completed: number;
  steps: number;
  rounds: number;
  calls: number;
  tokens: number;
  elapsedMs: number;
}

const ratio = (value: number, total: number) => total ? Number((value / total).toFixed(4)) : 0;
const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

function outcome(goal: GoalState): EvaluationRecord['outcome'] {
  if (goal.postMerge?.status === 'healthy') return 'healthy';
  if (['regressed', 'closed_unmerged'].includes(goal.postMerge?.status ?? '')) return 'regressed';
  if (goal.status === 'published') return 'published';
  if (goal.status === 'verified') return 'verified';
  return 'failed';
}

export function evaluateGoals(goals: GoalState[], suite?: string) {
  const records: EvaluationRecord[] = goals.filter(goal => goal.spec.evaluation && (!suite || goal.spec.evaluation.suite === suite))
    .map(goal => {
      const { evaluation: _evaluation, ...spec } = goal.spec;
      return { goalId: goal.id, ...goal.spec.evaluation!, caseDigest: taskId([goal.repository, goal.sha, spec]),
        configHash: goal.configHash, replayId: goal.evaluationRunId, goalStatus: goal.status,
        outcome: outcome(goal), completed: goal.completed.length, steps: goal.steps.length, rounds: goal.rounds,
        calls: goal.calls, tokens: goal.tokens, elapsedMs: goal.elapsedMs };
    })
    .sort((a, b) => a.suite.localeCompare(b.suite) || a.profile.localeCompare(b.profile)
      || a.case.localeCompare(b.case) || a.goalId.localeCompare(b.goalId));
  const duplicateKeys = [...new Set(records.map(record => `${record.suite}/${record.profile}/${record.case}`)
    .filter((key, index, all) => all.indexOf(key) !== index))];
  const inconsistentCases = [...new Set(records.map(record => `${record.suite}/${record.case}`))].filter(key => {
    const digests = records.filter(record => `${record.suite}/${record.case}` === key).map(record => record.caseDigest);
    return new Set(digests).size > 1;
  });
  const profiles = [...new Set(records.map(record => record.profile))].sort().map(profile => {
    const items = records.filter(record => record.profile === profile), terminal = items.filter(item => item.outcome !== 'failed');
    const verified = items.filter(item => ['verified', 'published', 'healthy'].includes(item.outcome));
    const published = items.filter(item => ['published', 'healthy'].includes(item.outcome));
    const observed = items.filter(item => ['healthy', 'regressed'].includes(item.outcome));
    return { profile, cases: items.length, completionRate: ratio(terminal.length, items.length),
      verificationRate: ratio(verified.length, items.length), publicationRate: ratio(published.length, items.length),
      postMergePassRate: ratio(items.filter(item => item.outcome === 'healthy').length, observed.length),
      regressions: items.filter(item => item.outcome === 'regressed').length,
      averageRounds: average(items.map(item => item.rounds)), averageCalls: average(items.map(item => item.calls)),
      averageTokens: average(items.map(item => item.tokens)), averageElapsedMs: average(items.map(item => item.elapsedMs)) };
  });
  const results = records.map(({ goalId: _goalId, ...record }) => record);
  return { schemaVersion: 1, suite: suite ?? null, digest: taskId(results), evidenceDigest: taskId(records),
    duplicateKeys, inconsistentCases, profiles, records };
}

type GateConfig = NonNullable<IterationConfig['strategyGate']>;
const success = (record: EvaluationRecord) => ['verified', 'published', 'healthy'].includes(record.outcome);
const sum = (records: EvaluationRecord[], key: 'calls' | 'tokens' | 'elapsedMs') =>
  records.reduce((total, record) => total + record[key], 0);

/** Promotion is only considered over the exact same pinned, terminal replay cases. */
export function compareEvaluationProfiles(goals: GoalState[], config: GateConfig,
  expectedCandidateConfigHash?: string) {
  const evaluation = evaluateGoals(goals.filter(goal => [config.baselineProfile, config.candidateProfile]
    .includes(goal.spec.evaluation?.profile ?? '')), config.suite);
  const reasons: string[] = [];
  const baseline = evaluation.records.filter(record => record.profile === config.baselineProfile);
  const candidate = evaluation.records.filter(record => record.profile === config.candidateProfile);
  if (config.baselineProfile === config.candidateProfile) reasons.push('Baseline and candidate profiles must differ.');
  if (baseline.length < config.minCases || candidate.length < config.minCases)
    reasons.push(`Each profile needs at least ${config.minCases} fixed cases.`);
  if (evaluation.duplicateKeys.length) reasons.push('Duplicate suite/profile/case records prevent comparison.');
  if (evaluation.inconsistentCases.length) reasons.push('Case inputs differ between profiles.');
  if ([...baseline, ...candidate].some(record => !record.replayId))
    reasons.push('Every compared case must come from a fixed-case replay.');
  if ([...baseline, ...candidate].some(record => ['planned', 'running', 'paused', 'stale'].includes(record.goalStatus)))
    reasons.push('All compared replays must reach a terminal, non-stale result.');
  if (new Set(baseline.map(record => record.configHash)).size !== 1
    || new Set(candidate.map(record => record.configHash)).size !== 1)
    reasons.push('A profile contains more than one configuration.');
  if (expectedCandidateConfigHash && candidate.some(record => record.configHash !== expectedCandidateConfigHash))
    reasons.push('Candidate profile does not match the current controller configuration.');
  const byCase = new Map(candidate.map(record => [record.case, record]));
  if (baseline.length !== candidate.length || baseline.some(record => !byCase.has(record.case)))
    reasons.push('Profiles must contain the same case IDs.');
  for (const record of baseline) {
    const other = byCase.get(record.case);
    if (!other || other.caseDigest !== record.caseDigest) continue;
    if (success(record) && !success(other)) reasons.push(`Candidate lost a verified case: ${record.case}.`);
  }
  const verificationRate = candidate.length ? candidate.filter(success).length / candidate.length : 0;
  if (verificationRate < config.minVerificationRate) reasons.push('Candidate verification rate is below the configured minimum.');
  if (candidate.some(record => record.outcome === 'regressed')) reasons.push('Candidate has a post-merge regression.');
  for (const [key, limit] of [
    ['calls', config.maxCallsRatio], ['tokens', config.maxTokensRatio], ['elapsedMs', config.maxElapsedRatio]
  ] as const) {
    const baseCost = sum(baseline, key), candidateCost = sum(candidate, key);
    if (baseCost === 0 ? candidateCost > 0 : candidateCost > baseCost * limit)
      reasons.push(`Candidate ${key} exceeds the configured ratio.`);
  }
  return { schemaVersion: 1, suite: config.suite, baselineProfile: config.baselineProfile,
    candidateProfile: config.candidateProfile, eligible: reasons.length === 0, reasons,
    cases: { baseline: baseline.length, candidate: candidate.length }, verificationRate,
    evidenceDigest: evaluation.evidenceDigest,
    decisionDigest: taskId([config, expectedCandidateConfigHash, evaluation.evidenceDigest, reasons]) };
}
