import { z } from 'zod';

export const serviceSchema = z.object({
  reviewPullRequests: z.boolean().default(false),
  progress: z.boolean().default(false),
  webhook: z.object({
    host: z.enum(['127.0.0.1', '0.0.0.0', '::1']).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8787),
    path: z.string().regex(/^\/[a-zA-Z0-9/_-]+$/).default('/github/webhook'),
    secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('REPOPILOT_WEBHOOK_SECRET'),
    maxBodyBytes: z.number().int().min(1024).max(5000000).default(1000000)
  }).strict().optional(),
  queue: z.object({
    maxBatch: z.number().int().min(1).max(100).default(20),
    maxPending: z.number().int().min(10).max(10000).default(1000),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    retentionDays: z.number().int().min(1).max(90).default(14)
  }).strict().default({ maxBatch: 20, maxPending: 1000, maxAttempts: 3, retentionDays: 14 }),
  limits: z.object({
    dailyCalls: z.number().int().positive().max(100000).default(200),
    dailyTokens: z.number().int().positive().max(1000000000).default(2000000),
    dailyTasks: z.number().int().positive().max(100000).default(20),
    failureThreshold: z.number().int().min(1).max(100).default(3)
  }).strict().default({ dailyCalls: 200, dailyTokens: 2000000, dailyTasks: 20, failureThreshold: 3 })
}).strict();
export type ServiceConfig = z.infer<typeof serviceSchema>;

export interface ServiceEvent {
  schemaVersion: 1; id: string; repository: string; delivery: string; digest: string;
  source: 'webhook' | 'poll' | 'operator'; event: string; receivedAt: string;
  key: string; kind: 'issue' | 'pull' | 'reconcile'; number?: number;
  approval?: { candidateId: string; evidenceDigest: string };
}
export interface EventReceipt {
  status: 'processing' | 'pending' | 'completed' | 'dead'; attempts: number;
  updatedAt: string; retryAfter?: string; reason?: string;
}
export interface QueuedEvent { event: ServiceEvent; receipt?: EventReceipt; }
export interface ServiceControl { id: string; action: 'pause' | 'resume'; at: string; }
export interface BudgetDay { calls: number; tokens: number; tasks: number; }
export interface BudgetReservation { day: string; tokens: number; settled: boolean; }
export interface ServiceLedger {
  schemaVersion: 1; repository: string; days: Record<string, BudgetDay>;
  reservations: Record<string, BudgetReservation>;
  failures: number; circuitReason?: string; operatorPaused: boolean; controlId?: string;
}
export interface ProgressMessage {
  schemaVersion: 1; id: string; repository: string; number: number; marker: string;
  body: string; digest: string; deliveredDigest?: string; commentId?: number;
  attempts: number; retryAfter?: string; updatedAt: string; error?: string;
  resumeId?: string;
}
