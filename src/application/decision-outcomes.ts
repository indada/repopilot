import type { DecisionObservation } from '../domain/decision-governance.js';
import { taskId } from '../domain/identity.js';
import type { CandidateStore } from '../ports/candidate.js';
import type { DecisionGovernanceStore } from '../ports/decision-governance.js';
import type { DecisionStore } from '../ports/decision.js';
import type { IterationStore } from '../ports/iteration.js';
import type { Store } from '../ports/store.js';

export interface OutcomeDependencies { repository: string; decisions: DecisionStore; governance: DecisionGovernanceStore;
  candidates: CandidateStore; goals: IterationStore; reports: Store; }

/** Observations link engineering evidence only; risk labels always remain an independent human judgment. */
export async function captureDecisionOutcomes(d: OutcomeDependencies) {
  const decisions = await d.decisions.list(d.repository); if (!decisions.length) return 0;
  const candidates = await d.candidates.list(), goals = await d.goals.list(); let count = 0;
  for (const decision of decisions) {
    const candidate = candidates.find(value => value.repository === d.repository && value.id === decision.candidateId);
    const current = candidate?.evidenceDigest === decision.evidenceDigest;
    const goal = goals.find(value => value.repository === d.repository && value.candidateId === decision.candidateId
      && (decision.subject ? value.sha === decision.subject.commit && taskId(value.spec.objective) === decision.subject.requestDigest : current));
    const report = current && candidate?.reproduction?.reportId ? await d.reports.read(candidate.reproduction.reportId) : undefined;
    const evidence: Omit<DecisionObservation, 'id' | 'schemaVersion' | 'observedAt'> = {
      repository: d.repository, decisionId: decision.id, candidateId: decision.candidateId, evidenceCurrent: !!current,
      candidateStatus: current ? candidate?.status : undefined,
      reproduction: report?.repository === d.repository ? { reportId: report.id, status: report.status, baseline: report.tests.base.status,
        stability: report.testStability?.status, reproduced: report.reproduction?.reproduced } : undefined,
      goal: goal ? { id: goal.id, status: goal.status, reports: goal.reports, publication: goal.publication,
        pullRequestUrl: goal.pullRequestUrl, postMerge: goal.postMerge?.status, calls: goal.calls, tokens: goal.tokens } : undefined
    };
    await d.governance.saveObservation({ schemaVersion: 1, id: taskId(['outcome', evidence]), ...evidence, observedAt: new Date().toISOString() }); count++;
  }
  return count;
}
