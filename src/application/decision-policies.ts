import { DECISION_QUESTION_VERSION, decisionPolicyDigest } from '../domain/decision-policy.js';
import type { DecisionConfig } from '../domain/decision.js';
import { decisionEvidenceDigest, policyVersion, type DecisionPolicyState } from '../domain/decision-governance.js';
import { taskId } from '../domain/identity.js';
import type { DecisionGovernanceStore } from '../ports/decision-governance.js';
import type { DecisionStore } from '../ports/decision.js';
import { applyDecisionPolicy, evaluationEligibility } from './decision-evaluation.js';

export function configuredPolicyVersion(repository: string, config: DecisionConfig) {
  return policyVersion(repository, { name: 'configured-baseline', model: config.model, questionVersion: DECISION_QUESTION_VERSION,
    mode: config.mode, minConfidence: config.minConfidence, minTestableProbability: config.minTestableProbability, maxRisk: config.maxRisk });
}

export async function effectiveDecisionConfig(repository: string, config: DecisionConfig, store: DecisionGovernanceStore) {
  if (!config.useManagedPolicy) return config;
  const state = await store.policyState(repository); if (!state?.active) return config;
  const policy = await store.policy(state.active);
  if (!policy || policy.repository !== repository) throw new Error('Active decision policy is missing or foreign.');
  return applyDecisionPolicy(config, policy);
}

export async function policyPreview(repository: string, config: DecisionConfig, store: DecisionGovernanceStore,
  action: 'activate' | 'rollback', policyId?: string, evaluationId?: string, decisions?: DecisionStore) {
  const state: DecisionPolicyState = await store.policyState(repository)
    ?? { schemaVersion: 1, repository, revision: 0, history: [] };
  const target = action === 'rollback' ? state.history.at(-1)?.from : policyId;
  const reasons: string[] = [];
  if (!config.enabled || !config.useManagedPolicy) reasons.push('Managed policy activation must be explicitly enabled in configuration.');
  if (action === 'rollback' && !state.history.length) reasons.push('There is no prior policy transition to roll back.');
  const policy = target ? await store.policy(target) : undefined;
  if (target && (!policy || policy.repository !== repository)) reasons.push('Policy version is missing or foreign.');
  if (policy && (policy.spec.model !== config.model || policy.spec.questionVersion !== DECISION_QUESTION_VERSION))
    reasons.push('Policy model or question version differs from the configured provider.');
  const evaluation = evaluationId ? await store.evaluation(evaluationId) : undefined;
  if (action === 'activate') {
    if (!policyId) reasons.push('A target policy is required.');
    if (!evaluation || evaluation.repository !== repository || evaluation.policyId !== target) reasons.push('A matching saved evaluation is required.');
    else {
      reasons.push(...evaluationEligibility(evaluation, config).reasons);
      if (!decisions) reasons.push('Promotion requires current decision evidence to be rechecked.');
      else for (const item of evaluation.cases) {
        const record = await decisions.read(item.decisionId), review = await store.review(item.reviewId);
        if (!record || record.repository !== repository || record.inputDigest !== item.inputDigest || decisionEvidenceDigest(record) !== item.evidenceDigest
          || !review || review.repository !== repository || review.evidenceDigest !== item.evidenceDigest)
          reasons.push('Fixed-case decision or human-review evidence changed before promotion.');
      }
    }
    if (state.active === target) reasons.push('The requested policy is already active.');
  }
  const basis = { repository, action, target, evaluationId, revision: state.revision, active: state.active,
    evaluationDigest: evaluation ? taskId(evaluation) : undefined, policyDigest: policy ? taskId(policy) : undefined,
    config: [config.enabled, config.useManagedPolicy, decisionPolicyDigest(config), config.promotion ?? null], reasons };
  return { token: taskId(basis), repository, action, target, evaluationId, previous: state.active ?? configuredPolicyVersion(repository, config).id,
    revision: state.revision, eligible: !reasons.length, reasons };
}

export async function applyPolicyTransition(repository: string, config: DecisionConfig, store: DecisionGovernanceStore,
  requestId: string, at: string, action: 'activate' | 'rollback', expected: string, policyId?: string, evaluationId?: string, decisions?: DecisionStore) {
  const state: DecisionPolicyState = await store.policyState(repository) ?? { schemaVersion: 1, repository, revision: 0, history: [] };
  if (state.history.some(item => item.id === requestId)) return state;
  const preview = await policyPreview(repository, config, store, action, policyId, evaluationId, decisions);
  if (preview.token !== expected || !preview.eligible) throw new Error('Policy preview changed or promotion evidence is ineligible.');
  const baseline = !state.active ? configuredPolicyVersion(repository, config) : undefined;
  if (baseline) await store.savePolicy(baseline);
  state.history.push({ id: requestId, at, kind: action, from: state.active ?? baseline?.id, to: preview.target, evaluationId });
  state.active = preview.target; state.revision++; await store.savePolicyState(state); return state;
}
