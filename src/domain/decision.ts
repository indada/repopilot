import { z } from 'zod';

export const decisionSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.literal('jev').default('jev'),
  model: z.string().regex(/^jev-\d+\.\d+\.\d+$/).default('jev-1.13.0'),
  mode: z.enum(['shadow', 'gate']).default('shadow'),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('TYPESAFE_API_KEY'),
  timeoutSeconds: z.number().int().min(1).max(60).default(10),
  maxInputBytes: z.number().int().min(1024).max(32000).default(12000),
  minConfidence: z.number().min(0.5).max(1).default(0.85),
  minTestableProbability: z.number().min(0.5).max(1).default(0.9),
  maxRisk: z.enum(['low', 'medium']).default('low'),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  retrySeconds: z.number().int().min(5).max(3600).default(60),
  limits: z.object({
    dailyCalls: z.number().int().min(1).max(10000).default(100),
    dailyTokens: z.number().int().min(1000).max(1000000000).default(500000),
    tokensPerCall: z.number().int().min(1000).max(100000).default(16000)
  }).strict().default({ dailyCalls: 100, dailyTokens: 500000, tokensPerCall: 16000 })
}).strict().refine(value => value.limits.dailyTokens >= value.limits.tokensPerCall,
  { message: 'Decision dailyTokens must fit one tokensPerCall reservation.', path: ['limits', 'dailyTokens'] });

export type DecisionConfig = z.infer<typeof decisionSchema>;
export interface DecisionSubject {
  repository: string; candidateId: string; evidenceDigest: string; issue: number;
  commit: string; branch: string; title: string; request: string;
  intent: 'bugfix' | 'feature'; allowedPaths: string[];
}
export type DecisionKind = 'bugfix' | 'feature' | 'question' | 'unclear';
export type DecisionRisk = 'low' | 'medium' | 'high' | 'unknown';
export interface DecisionChoice<T extends string> {
  type: 'choice'; choice: T; probabilities: Record<T, number>; confidence: number;
}
export interface DecisionResult {
  model: string;
  answers: {
    kind: DecisionChoice<DecisionKind>;
    risk: DecisionChoice<DecisionRisk>;
    urgency: { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
    testable: { type: 'noul'; noul: number };
  };
  usage: { input_tokens: number; output_tokens: number };
}
export type DecisionFailure = 'missing_key' | 'input_too_large' | 'invalid_response' | 'http_error' | 'rate_limited' | 'transport' | 'interrupted' | 'budget_exhausted';
export interface DecisionRecord {
  schemaVersion: 1; id: string; repository: string; candidateId: string; evidenceDigest: string;
  inputDigest: string; questionVersion: number; requestedModel: string; intent: DecisionSubject['intent'];
  status: 'running' | 'evaluated' | 'error' | 'deferred'; attempts: number;
  createdAt: string; updatedAt: string; retryAfter?: string; failure?: DecisionFailure; retryable?: boolean;
  result?: DecisionResult;
}
export interface DecisionSummary {
  id: string; policyDigest: string; mode: DecisionConfig['mode']; status: DecisionRecord['status']; route: 'continue' | 'review'; reasons: string[];
  model?: string; kind?: DecisionKind; risk?: DecisionRisk; urgency?: number; testableProbability?: number;
  retryAfter?: string;
}
export interface DecisionLedger {
  schemaVersion: 1; repository: string;
  days: Record<string, { calls: number; tokens: number }>;
  reservations: Record<string, { day: string; tokens: number }>;
}
