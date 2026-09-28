import type { IssueSource, PullRequest, Snapshot } from './types.js';

export interface RunInput { base: Snapshot; head: Snapshot; baseSha: string; headSha: string; pr?: PullRequest; description?: string;
  repoPath?: string; runKey?: string; rerunOf?: string; issue?: IssueSource;
  implementation?: { mode: 'feature' | 'bugfix'; acceptance: string[]; allowedPaths: string[] };
  previousPatches?: string[];
  keepBudget?: boolean; reproductionOnly?: boolean; }
