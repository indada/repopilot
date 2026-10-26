import type { Config } from '../domain/config.js';
import type { DashboardSnapshot } from '../domain/dashboard.js';
import type { CandidateStore } from '../ports/candidate.js';
import type { DecisionGovernanceStore } from '../ports/decision-governance.js';
import type { DecisionStore } from '../ports/decision.js';
import type { IterationStore } from '../ports/iteration.js';
import type { ServiceStore } from '../ports/service.js';
import type { Store } from '../ports/store.js';
import { decisionBudgetStatus } from './decisions.js';
import { budgetStatus } from './service-budget.js';

export async function dashboardSnapshot(config: Config, version: string, stores: { candidates: CandidateStore; goals: IterationStore;
  reports: Store; decisions: DecisionStore; governance: DecisionGovernanceStore; services: ServiceStore }): Promise<DashboardSnapshot> {
  const [allCandidates, allGoals, allReports, decisions, reviews, requests, events, state, codexLedger, jevLedger, control] = await Promise.all([
    stores.candidates.list(), stores.goals.list(), stores.reports.list(), stores.decisions.list(config.repository),
    stores.governance.reviews(config.repository), stores.governance.requests(config.repository), stores.services.events(config.repository),
    stores.governance.policyState(config.repository), stores.services.ledger(config.repository), stores.decisions.ledger(config.repository),
    stores.services.control(config.repository)
  ]);
  const candidates = allCandidates.filter(value => value.repository === config.repository), goals = allGoals.filter(value => value.repository === config.repository);
  const reports = allReports.filter(value => value.repository === config.repository);
  const codex = config.service ? budgetStatus(codexLedger, config.service, Date.now(), config.agent.enabled ? config.agent.maxTokens : 0) : undefined;
  const jev = config.decision ? decisionBudgetStatus(jevLedger, config.decision) : undefined;
  return { schemaVersion: 1, version, repository: config.repository, generatedAt: new Date().toISOString(),
    counts: { candidates: candidates.length, goals: goals.length, reports: reports.length, decisions: decisions.length,
      reviews: reviews.length, pendingRequests: requests.filter(value => !value.receipt).length },
    budgets: { codex: codex ? { ...codex.used, paused: control?.action === 'pause' || codex.paused, reasons: codex.reasons } : undefined,
      jev: jev ? { ...jev.used, available: jev.available, unknownCalls: jev.unknownCalls } : undefined },
    policy: { revision: state?.revision ?? 0, active: state?.active, managed: config.decision?.useManagedPolicy ?? false },
    candidates: candidates.slice(0, 100).map(value => ({ id: value.id, issue: value.issue, status: value.status,
      route: value.decision?.route, risk: value.decision?.risk, decisionId: value.decision?.id })),
    goals: goals.slice(0, 100).map(value => ({ id: value.id, status: value.status, completed: value.completed.length, total: value.steps.length,
      steps: value.steps.map(step => ({ id: step.id, status: value.stepStates?.[step.id]?.status ?? (value.completed.includes(step.id) ? 'completed' : 'pending'),
        dependsOn: step.dependsOn })) })),
    decisions: decisions.slice(0, 100).map(value => ({ id: value.id, status: value.status, model: value.requestedModel, attempts: value.attempts })),
    requests: requests.slice(-100).reverse().map(value => ({ id: value.request.id, action: value.request.action, status: value.receipt?.status ?? 'pending' })),
    events: { pending: events.filter(value => !value.receipt || value.receipt.status === 'pending').length,
      processing: events.filter(value => value.receipt?.status === 'processing').length,
      completed: events.filter(value => value.receipt?.status === 'completed').length, dead: events.filter(value => value.receipt?.status === 'dead').length } };
}
