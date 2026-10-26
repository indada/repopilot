import type { DecisionAdmission, DecisionEvaluation, DecisionObservation, DecisionPolicyState, DecisionPolicyVersion,
  DecisionReview, GovernanceReceipt, GovernanceRequest } from '../domain/decision-governance.js';

export interface DecisionGovernanceStore {
  policy(id: string): Promise<DecisionPolicyVersion | undefined>;
  policies(repository: string): Promise<DecisionPolicyVersion[]>;
  savePolicy(value: DecisionPolicyVersion): Promise<void>;
  review(id: string): Promise<DecisionReview | undefined>;
  reviews(repository: string): Promise<DecisionReview[]>;
  saveReview(value: DecisionReview): Promise<void>;
  evaluation(id: string): Promise<DecisionEvaluation | undefined>;
  evaluations(repository: string): Promise<DecisionEvaluation[]>;
  saveEvaluation(value: DecisionEvaluation): Promise<void>;
  observations(repository: string): Promise<DecisionObservation[]>;
  saveObservation(value: DecisionObservation): Promise<void>;
  admissions(repository: string): Promise<DecisionAdmission[]>;
  saveAdmission(value: DecisionAdmission): Promise<void>;
  policyState(repository: string): Promise<DecisionPolicyState | undefined>;
  savePolicyState(value: DecisionPolicyState): Promise<void>;
  enqueue(value: GovernanceRequest, maxPending: number): Promise<void>;
  requests(repository: string): Promise<{ request: GovernanceRequest; receipt?: GovernanceReceipt }[]>;
  receipt(id: string, value: GovernanceReceipt): Promise<void>;
}
