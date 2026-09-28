import { z } from 'zod';
import { safePath } from './snapshot.js';
import { createHash } from 'node:crypto';
import { runnerSchema } from './runner-config.js';
import { collaborationSchema, type AgentHandoff } from './collaboration.js';
import type { RepairChange, TestResult } from './types.js';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const taskId = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export const goalSpecSchema = z.object({
  title: z.string().min(8).max(200), objective: z.string().min(8).max(12000),
  mode: z.enum(['feature', 'bugfix']), branch: z.string().min(1).max(200).optional(),
  issue: z.number().int().positive().optional(),
  acceptance: z.array(z.object({ id, text: z.string().min(8).max(2000) }).strict()).min(1).max(20),
  allowedPaths: z.array(z.string().refine(safePath)).min(1).max(30),
  evaluation: z.object({ suite: id, case: id, profile: id }).strict().optional()
}).strict().refine(s => new Set(s.acceptance.map(a => a.id)).size === s.acceptance.length, 'Acceptance IDs must be unique.');
export type GoalSpec = z.infer<typeof goalSpecSchema>;
export const goalStepSchema = z.object({
  id, title: z.string().min(8).max(200), acceptanceIds: z.array(id).min(1).max(20),
  dependsOn: z.array(id).max(20)
}).strict();
export type GoalStep = z.infer<typeof goalStepSchema>;
export interface WaveAudit {
  id: string; inputDigest: string; stepIds: string[]; capacity: number;
  status: 'running' | 'merged' | 'partial' | 'failed' | 'interrupted';
  accepted: string[]; deferred: string[]; rejected: string[];
  conflicts: { path: string; owner: string; deferred: string }[];
  pathOwners: Record<string, string>; reportIds: Record<string, string>;
  reason?: string; updatedAt: string;
}
export const strategyGateSchema = z.object({ suite: id, baselineProfile: id, candidateProfile: id,
  minCases: z.number().int().min(1).max(100).default(3),
  minVerificationRate: z.number().min(0).max(1).default(0.9),
  maxCallsRatio: z.number().positive().max(10).default(1.5),
  maxTokensRatio: z.number().positive().max(10).default(1.5),
  maxElapsedRatio: z.number().positive().max(10).default(2)
}).strict();
export const iterationSchema = z.object({
  maxSteps: z.number().int().min(1).max(20).default(8),
  maxRounds: z.number().int().min(1).max(20).default(3),
  maxCalls: z.number().int().min(1).max(500).default(80),
  maxTokens: z.number().int().min(1000).max(10000000).default(1000000),
  timeoutSeconds: z.number().int().min(10).max(86400).default(7200),
  queue: z.object({ labels: z.array(z.string().min(1)).min(1).max(10),
    trustedAuthors: z.array(z.string().min(1)).min(1).max(50),
    allowedPaths: z.array(z.string().refine(safePath)).min(1).max(30),
    featureLabel: z.string().min(1).default('enhancement'),
    priorityLabels: z.array(z.string().min(1)).max(10).default([]),
    maxPerRun: z.number().int().min(1).max(10).default(1)
  }).strict().optional(),
  maintenance: z.object({ trustedReviewers: z.array(z.string().min(1)).min(1).max(50),
    requiredChecks: z.array(z.string().min(1)).min(1).max(30)
  }).strict().optional(),
  postMerge: z.object({
    requiredChecks: z.array(z.string().min(1)).min(1).max(30),
    requireIssueClosed: z.boolean().default(true)
  }).strict().optional(),
  collaboration: collaborationSchema.optional(),
  strategyGate: strategyGateSchema.optional(),
  preview: runnerSchema.optional()
}).strict();
export type IterationConfig = z.infer<typeof iterationSchema>;
export interface GoalState {
  schemaVersion: 1; id: string; repository: string; spec: GoalSpec; configHash: string;
  branch: string; sha: string; issueDigest?: string; createdAt: string; updatedAt: string;
  status: 'planned' | 'running' | 'paused' | 'needs_attention' | 'verified' | 'published' | 'stale';
  steps: GoalStep[]; completed: string[]; changes: RepairChange[];
  stepStates?: Record<string, { status: 'pending' | 'running' | 'completed' | 'rejected' | 'blocked';
    attempts: number; reportId?: string; reason?: string; updatedAt: string }>;
  reports: string[]; rounds: number; calls: number; tokens: number; elapsedMs: number;
  activeSince?: string;
  candidateId?: string;
  evaluationRunId?: string;
  queued?: boolean;
  active?: { step: string; runKey: string }; notes: string[];
  parallelBatch?: { id?: string; baseDigest: string; priorReports: string[];
    steps: { id: string; runKey: string; settled: boolean; reportId?: string }[] };
  waveHistory?: WaveAudit[];
  serialReplay?: string[];
  criterionAttempts?: Record<string, number>;
  publication?: string; pullRequestUrl?: string;
  maintenance?: { reportId: string; digest: string; consumed: string[]; head?: string; base?: string;
    pendingComments?: string[];
    patches?: string[];
    outcome?: 'running' | 'failed' | 'verified' | 'updated' };
  preview?: { candidate: TestResult; rollback: TestResult };
  handoffs?: AgentHandoff[];
  postMerge?: {
    pull: number;
    status: 'waiting_for_merge' | 'observing' | 'healthy' | 'regressed' | 'closed_unmerged';
    mergeSha?: string;
    mergedAt?: string;
    checkedAt: string;
    checks: { name: string; status: string; conclusion: string | null }[];
    issueState?: string;
    reasons: string[];
  };
}
export function validateSteps(steps: GoalStep[], spec: GoalSpec, limit: number): GoalStep[] {
  const parsed = z.array(goalStepSchema).min(1).max(limit).parse(steps);
  const seen = new Set<string>(), covered = new Set<string>();
  for (const step of parsed) {
    if (seen.has(step.id) || step.dependsOn.some(d => !seen.has(d))) throw new Error('Plan must have unique, dependency-ordered steps.');
    seen.add(step.id);
    for (const criterion of step.acceptanceIds) {
      if (!spec.acceptance.some(a => a.id === criterion) || covered.has(criterion)) throw new Error('Each acceptance criterion must belong to exactly one step.');
      covered.add(criterion);
    }
  }
  if (covered.size !== spec.acceptance.length) throw new Error('Plan omitted acceptance criteria.');
  return parsed;
}
export function withinScope(path: string, allowed: string[]): boolean {
  return safePath(path) && allowed.some(p => path === p || path.startsWith(p + '/'));
}
export function patchDigest(changes: RepairChange[]): string {
  return taskId([...changes].sort((a, b) => a.path.localeCompare(b.path)));
}
export function issueDigest(issue: { title: string; body: string | null }): string { return taskId([issue.title, issue.body ?? '']); }
export interface Experience {
  id: string; goalId: string; repository: string; sha: string; configHash: string;
  outcome: GoalState['status']; completed: string[]; reportIds: string[]; notes: string[]; createdAt: string;
}
