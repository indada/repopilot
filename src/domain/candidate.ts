import { taskId } from './identity.js';
import type { TestResult } from './types.js';

export type CandidateKind = 'issue' | 'ci' | 'policy' | 'review' | 'post_merge' | 'baseline';
export type CandidateStatus = 'observed' | 'reproduced' | 'approved' | 'running' | 'completed' | 'blocked' | 'stale';

export interface CandidateSignal {
  kind: CandidateKind;
  repository: string;
  identity: unknown[];
  evidence: unknown;
  commit: string;
  branch?: string;
  issue?: number;
  goalId?: string;
  reportId?: string;
  path?: string;
  ruleId?: string;
  title: string;
  detail: string;
  priority: number;
  priorityReasons: string[];
}

export interface Candidate {
  schemaVersion: 1;
  id: string;
  repository: string;
  kind: CandidateKind;
  evidenceDigest: string;
  commit: string;
  branch?: string;
  issue?: number;
  sourceGoalId?: string;
  reportId?: string;
  path?: string;
  ruleId?: string;
  title: string;
  detail: string;
  priority: number;
  priorityReasons: string[];
  status: CandidateStatus;
  firstSeenAt: string;
  updatedAt: string;
  reproduction?: { status: 'reproduced' | 'not_reproduced' | 'inconclusive'; reportId?: string;
    first?: TestResult; second?: TestResult; at: string; reason: string };
  goalId?: string;
  reason?: string;
  failureCount?: number;
  retryAfter?: string;
}

export function candidateFromSignal(signal: CandidateSignal, previous?: Candidate, now = new Date().toISOString()): Candidate {
  const id = taskId([signal.repository, signal.kind, signal.identity]);
  const evidenceDigest = taskId([signal.commit, signal.branch, signal.evidence]);
  if (previous && (previous.id !== id || previous.repository !== signal.repository)) throw new Error('Candidate identity mismatch.');
  const changed = !!previous && previous.evidenceDigest !== evidenceDigest;
  return { schemaVersion: 1, id, repository: signal.repository, kind: signal.kind,
    evidenceDigest, commit: signal.commit, branch: signal.branch, issue: signal.issue,
    sourceGoalId: signal.goalId, reportId: signal.reportId, path: signal.path, ruleId: signal.ruleId,
    // Issue title limits are enforced at intake; preserve the source text so it cannot be silently shortened.
    title: signal.kind === 'issue' ? signal.title : signal.title.slice(0, 200),
    detail: signal.detail.slice(0, 12000), priority: signal.priority, priorityReasons: signal.priorityReasons,
    status: changed ? 'stale' : previous?.status ?? 'observed',
    firstSeenAt: previous?.firstSeenAt ?? now, updatedAt: changed ? now : previous?.updatedAt ?? now,
    reproduction: changed ? undefined : previous?.reproduction,
    goalId: previous?.goalId, reason: changed ? 'Source evidence changed; prior reproduction and approval remain invalid.' : previous?.reason,
    failureCount: changed ? undefined : previous?.failureCount,
    retryAfter: changed ? undefined : previous?.retryAfter };
}

export function orderCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => b.priority - a.priority
    || a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
}
