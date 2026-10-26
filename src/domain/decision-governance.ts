import { z } from 'zod';
import { taskId } from './identity.js';
import type { DecisionRecord, DecisionSummary } from './decision.js';

export const evidenceId = z.string().regex(/^[a-f0-9]{24}$/);
export const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const policySpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  model: z.string().regex(/^jev-\d+\.\d+\.\d+$/),
  questionVersion: z.number().int().positive().default(1),
  mode: z.enum(['shadow', 'gate']).default('shadow'),
  minConfidence: z.number().min(0.5).max(1).default(0.85),
  minTestableProbability: z.number().min(0.5).max(1).default(0.9),
  maxRisk: z.enum(['low', 'medium']).default('low')
}).strict();
export type DecisionPolicySpec = z.infer<typeof policySpecSchema>;
export interface DecisionPolicyVersion { schemaVersion: 1; id: string; repository: string; spec: DecisionPolicySpec; }
export const reviewSpecSchema = z.object({
  expectedRoute: z.enum(['continue', 'review']),
  expectedKind: z.enum(['bugfix', 'feature', 'question', 'unclear']).optional(),
  expectedRisk: z.enum(['low', 'medium', 'high', 'unknown']).optional(),
  testable: z.boolean().optional(),
  reviewer: z.string().trim().min(1).max(80),
  note: z.string().max(1000).default('')
}).strict();
export type DecisionReviewSpec = z.infer<typeof reviewSpecSchema>;
export interface DecisionReview {
  schemaVersion: 1; id: string; repository: string; decisionId: string; inputDigest: string;
  evidenceDigest: string; labels: DecisionReviewSpec; createdAt: string; requestId: string;
}
export const decisionSuiteSchema = z.object({
  schemaVersion: z.literal(1), repository: repositoryName, suite: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  cases: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), decisionId: evidenceId,
    inputDigest: evidenceId, evidenceDigest: evidenceId, reviewId: evidenceId }).strict()).min(1).max(500)
}).strict().refine(value => new Set(value.cases.map(item => item.id)).size === value.cases.length
  && new Set(value.cases.map(item => item.decisionId)).size === value.cases.length, 'Suite cases and decisions must be unique.');
export type DecisionSuite = z.infer<typeof decisionSuiteSchema>;
export interface DecisionEvaluation {
  schemaVersion: 1; id: string; repository: string; suite: string; datasetDigest: string; policyId: string;
  createdAt: string; cases: { id: string; decisionId: string; reviewId: string; inputDigest: string; evidenceDigest: string;
    expected: 'continue' | 'review'; route: 'continue' | 'review'; available: boolean }[];
  metrics: { total: number; available: number; allowed: number; deferred: number; expectedAllow: number; expectedReview: number;
    falseAllow: number; falseReview: number; falseAllowRate: number; falseReviewRate: number;
    kindLabeled: number; kindCorrect: number; riskLabeled: number; riskCorrect: number; testableLabeled: number; testableCorrect: number;
    tokens: number; elapsedMs: number; unknownUsage: number };
}
export interface DecisionObservation {
  schemaVersion: 1; id: string; repository: string; decisionId: string; observedAt: string;
  candidateId: string; evidenceCurrent: boolean; candidateStatus?: string;
  reproduction?: { reportId: string; status: string; baseline: string; stability?: string; reproduced?: boolean };
  goal?: { id: string; status: string; reports: string[]; publication?: string; pullRequestUrl?: string; postMerge?: string; calls: number; tokens: number };
}
export interface DecisionAdmission {
  schemaVersion: 1; id: string; repository: string; decisionId: string; candidateId: string;
  evidenceDigest: string; summary: DecisionSummary; observedAt: string;
}
export interface PolicyTransition {
  id: string; at: string; kind: 'activate' | 'rollback'; from?: string; to?: string; evaluationId?: string;
}
export interface DecisionPolicyState { schemaVersion: 1; repository: string; revision: number; active?: string; history: PolicyTransition[]; }
const requestBase = { schemaVersion: z.literal(1), id: evidenceId, repository: repositoryName, createdAt: z.iso.datetime() };
export const governanceRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...requestBase, action: z.literal('review'), decisionId: evidenceId, inputDigest: evidenceId,
    evidenceDigest: evidenceId, labels: reviewSpecSchema }).strict(),
  z.object({ ...requestBase, action: z.literal('retry'), decisionId: evidenceId, inputDigest: evidenceId, recordDigest: evidenceId }).strict(),
  z.object({ ...requestBase, action: z.literal('activate'), policyId: evidenceId.optional(),
    evaluationId: evidenceId.optional(), expected: evidenceId }).strict(),
  z.object({ ...requestBase, action: z.literal('rollback'), policyId: evidenceId.optional(),
    evaluationId: evidenceId.optional(), expected: evidenceId }).strict()
]);
export type GovernanceRequest = z.infer<typeof governanceRequestSchema>;
export interface GovernanceReceipt { status: 'applied' | 'rejected'; at: string; reason: string; resultId?: string; }
export function decisionEvidenceDigest(record: DecisionRecord) {
  return taskId([record.repository, record.id, record.inputDigest, record.evidenceDigest, record.questionVersion,
    record.requestedModel, record.intent, record.status, record.result ?? null]);
}
export function policyVersion(repository: string, raw: unknown): DecisionPolicyVersion {
  const spec = policySpecSchema.parse(raw);
  return { schemaVersion: 1, id: taskId(['decision-policy', repository, spec]), repository, spec };
}
