export interface DashboardSnapshot {
  schemaVersion: 1; version: string; repository: string; generatedAt: string;
  counts: { candidates: number; goals: number; reports: number; decisions: number; reviews: number; pendingRequests: number };
  budgets: { codex?: { calls: number; tokens: number; tasks: number; paused: boolean; reasons: string[] };
    jev?: { calls: number; tokens: number; available: boolean; unknownCalls: number } };
  policy: { revision: number; active?: string; managed: boolean };
  candidates: { id: string; issue?: number; status: string; route?: string; risk?: string; decisionId?: string }[];
  goals: { id: string; status: string; completed: number; total: number;
    steps: { id: string; status: string; dependsOn: string[] }[] }[];
  decisions: { id: string; status: string; model: string; attempts: number }[];
  requests: { id: string; action: string; status: string }[];
  events: { pending: number; processing: number; completed: number; dead: number };
}
