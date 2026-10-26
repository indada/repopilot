import { DECISION_QUESTION_VERSION, summarizeDecision } from '../domain/decision-policy.js';
import { decisionEvidenceDigest, decisionSuiteSchema, type DecisionEvaluation, type DecisionPolicyVersion,
  type DecisionSuite } from '../domain/decision-governance.js';
import type { DecisionConfig } from '../domain/decision.js';
import { taskId } from '../domain/identity.js';
import type { DecisionGovernanceStore } from '../ports/decision-governance.js';
import type { DecisionStore } from '../ports/decision.js';

const ratio = (count: number, total: number) => total ? count / total : 0;
export function applyDecisionPolicy(config: DecisionConfig, policy: DecisionPolicyVersion): DecisionConfig {
  if (policy.spec.model !== config.model || policy.spec.questionVersion !== DECISION_QUESTION_VERSION)
    throw new Error('Policy model and question version must match the configured decision provider.');
  const { name: _name, questionVersion: _version, ...settings } = policy.spec;
  return { ...config, ...settings };
}

export async function exportDecisionSuite(repository: string, suite: string, store: DecisionStore, governance: DecisionGovernanceStore): Promise<DecisionSuite> {
  const records = await store.list(repository), reviews = await governance.reviews(repository);
  const cases: DecisionSuite['cases'] = [];
  for (const record of records) {
    const digest = decisionEvidenceDigest(record);
    const review = reviews.filter(value => value.decisionId === record.id && value.inputDigest === record.inputDigest && value.evidenceDigest === digest)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    if (review) cases.push({ id: 'case-' + record.id, decisionId: record.id, inputDigest: record.inputDigest, evidenceDigest: digest, reviewId: review.id });
  }
  return decisionSuiteSchema.parse({ schemaVersion: 1, repository, suite, cases: cases.sort((a, b) => a.id.localeCompare(b.id)) });
}

/** Offline evaluation binds explicit human labels and immutable decision evidence; it makes no provider calls. */
export async function evaluateDecisions(raw: unknown, repository: string, config: DecisionConfig, policy: DecisionPolicyVersion,
  store: DecisionStore, governance: DecisionGovernanceStore): Promise<DecisionEvaluation> {
  const suite = decisionSuiteSchema.parse(raw);
  if (suite.repository !== repository || policy.repository !== repository) throw new Error('Decision evaluation repository mismatch.');
  const settings = applyDecisionPolicy(config, policy), cases: DecisionEvaluation['cases'] = [];
  const metrics: DecisionEvaluation['metrics'] = { total: suite.cases.length, available: 0, allowed: 0, deferred: 0,
    expectedAllow: 0, expectedReview: 0, falseAllow: 0, falseReview: 0, falseAllowRate: 0, falseReviewRate: 0,
    kindLabeled: 0, kindCorrect: 0, riskLabeled: 0, riskCorrect: 0, testableLabeled: 0, testableCorrect: 0,
    tokens: 0, elapsedMs: 0, unknownUsage: 0 };
  for (const item of suite.cases) {
    const record = await store.read(item.decisionId), review = await governance.review(item.reviewId);
    if (!record || record.repository !== repository || record.inputDigest !== item.inputDigest || decisionEvidenceDigest(record) !== item.evidenceDigest
      || !review || review.repository !== repository || review.decisionId !== record.id || review.inputDigest !== item.inputDigest
      || review.evidenceDigest !== item.evidenceDigest) throw new Error('Fixed-case decision or human-review evidence changed or is missing.');
    if (record.requestedModel !== policy.spec.model || record.questionVersion !== policy.spec.questionVersion)
      throw new Error('Offline replay cannot evaluate a different model or question version.');
    const summary = summarizeDecision(record, settings), expected = review.labels.expectedRoute;
    const available = record.status === 'evaluated' && !!record.result;
    cases.push({ id: item.id, decisionId: record.id, reviewId: review.id, inputDigest: record.inputDigest,
      evidenceDigest: item.evidenceDigest, expected, route: summary.route, available });
    metrics.available += Number(available); metrics.allowed += Number(summary.route === 'continue'); metrics.deferred += Number(summary.route === 'review');
    metrics.expectedAllow += Number(expected === 'continue'); metrics.expectedReview += Number(expected === 'review');
    metrics.falseAllow += Number(summary.route === 'continue' && expected === 'review');
    metrics.falseReview += Number(summary.route === 'review' && expected === 'continue');
    if (review.labels.expectedKind) { metrics.kindLabeled++; metrics.kindCorrect += Number(summary.kind === review.labels.expectedKind); }
    if (review.labels.expectedRisk) { metrics.riskLabeled++; metrics.riskCorrect += Number(summary.risk === review.labels.expectedRisk); }
    if (review.labels.testable !== undefined) {
      metrics.testableLabeled++; metrics.testableCorrect += Number(available && (summary.testableProbability! >= settings.minTestableProbability) === review.labels.testable);
    }
    metrics.tokens += record.result ? record.result.usage.input_tokens + record.result.usage.output_tokens : 0;
    metrics.unknownUsage += Number(!record.result && record.attempts > 0); metrics.elapsedMs += record.elapsedMs ?? 0;
  }
  metrics.falseAllowRate = ratio(metrics.falseAllow, metrics.expectedReview); metrics.falseReviewRate = ratio(metrics.falseReview, metrics.expectedAllow);
  const datasetDigest = taskId(suite), id = taskId(['decision-evaluation', repository, datasetDigest, policy.id, cases, metrics]);
  const previous = await governance.evaluation(id);
  return previous ?? { schemaVersion: 1, id, repository, suite: suite.suite, datasetDigest, policyId: policy.id,
    createdAt: new Date().toISOString(), cases, metrics };
}

export function evaluationEligibility(evaluation: DecisionEvaluation, config: DecisionConfig) {
  const policy = config.promotion ?? { minCases: 3, maxFalseAllow: 0, maxFalseReviewRate: 0.2 }, reasons: string[] = [];
  if (evaluation.metrics.total < policy.minCases) reasons.push('Not enough manually reviewed fixed cases.');
  if (!evaluation.metrics.expectedAllow || !evaluation.metrics.expectedReview) reasons.push('Evaluation must cover both human-approved routes.');
  if (evaluation.metrics.available !== evaluation.metrics.total) reasons.push('Every promotion case requires a valid evaluated decision.');
  if (evaluation.metrics.falseAllow > policy.maxFalseAllow) reasons.push('False allow count exceeds the promotion limit.');
  if (evaluation.metrics.falseReviewRate > policy.maxFalseReviewRate) reasons.push('False review rate exceeds the promotion limit.');
  return { eligible: !reasons.length, reasons, limits: policy };
}

export function compareDecisions(baseline: DecisionEvaluation, candidate: DecisionEvaluation) {
  if (baseline.repository !== candidate.repository || baseline.datasetDigest !== candidate.datasetDigest)
    throw new Error('Decision comparisons require the same repository, cases, evidence and human labels.');
  return { baseline: baseline.id, candidate: candidate.id, datasetDigest: baseline.datasetDigest,
    metrics: { baseline: baseline.metrics, candidate: candidate.metrics },
    changedRoutes: candidate.cases.filter(item => baseline.cases.find(other => other.id === item.id)?.route !== item.route) };
}

export async function sweepDecisionThresholds(raw: unknown, repository: string, config: DecisionConfig, policy: DecisionPolicyVersion,
  store: DecisionStore, governance: DecisionGovernanceStore) {
  const results = [];
  for (const confidence of [0.7, 0.85, 0.95]) for (const testable of [0.8, 0.9, 0.95]) {
    const spec = { ...policy.spec, minConfidence: confidence, minTestableProbability: testable };
    const variant = { ...policy, id: taskId(['sweep', policy.id, confidence, testable]), spec };
    const evaluated = await evaluateDecisions(raw, repository, config, variant, store, governance);
    results.push({ minConfidence: confidence, minTestableProbability: testable, metrics: evaluated.metrics,
      ...evaluationEligibility(evaluated, config) });
  }
  return { policyId: policy.id, providerCalls: 0, results };
}
