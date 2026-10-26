import { governanceRequestSchema, decisionEvidenceDigest } from '../domain/decision-governance.js';
import type { Config } from '../domain/config.js';
import { taskId } from '../domain/identity.js';
import { pollEvent } from '../domain/service-events.js';
import type { DecisionGovernanceStore } from '../ports/decision-governance.js';
import type { DecisionStore } from '../ports/decision.js';
import type { ServiceStore } from '../ports/service.js';
import { applyPolicyTransition, policyPreview } from './decision-policies.js';

export async function processDecisionRequests(config: Config, store: DecisionStore, governance: DecisionGovernanceStore,
  services?: ServiceStore, limit = 20) {
  const result: { id: string; status: string }[] = [];
  for (const item of (await governance.requests(config.repository)).filter(item => !item.receipt).slice(0, limit)) {
    const request = governanceRequestSchema.parse(item.request);
    if (request.repository !== config.repository) throw new Error('Operator request repository mismatch.');
    let resultId: string | undefined, rejection: string | undefined;
    if (request.action === 'activate' || request.action === 'rollback') {
      if (!config.decision) rejection = 'Decision configuration is missing.';
      else {
        // Preflight rejection is separate from durable state writes; disk errors remain fatal.
        const state = await governance.policyState(config.repository);
        if (!state?.history.some(value => value.id === request.id)) {
          const preview = await policyPreview(config.repository, config.decision, governance, request.action, request.policyId, request.evaluationId, store);
          if (!preview.eligible || preview.token !== request.expected) rejection = 'Policy preview changed or promotion evidence is ineligible.';
        }
        if (!rejection) await applyPolicyTransition(config.repository, config.decision, governance, request.id, request.createdAt,
          request.action, request.expected, request.policyId, request.evaluationId, store);
      }
    } else {
      const record = await store.read(request.decisionId);
      if (!record || record.repository !== config.repository || record.inputDigest !== request.inputDigest) rejection = 'Decision input no longer matches the operator request.';
      else if (request.action === 'review') {
        if (decisionEvidenceDigest(record) !== request.evidenceDigest) rejection = 'Decision evidence changed before human review was applied.';
        else {
          resultId = taskId(['human-review', request.id]);
          await governance.saveReview({ schemaVersion: 1, id: resultId, repository: config.repository,
            decisionId: record.id, inputDigest: record.inputDigest, evidenceDigest: request.evidenceDigest,
            labels: request.labels, createdAt: request.createdAt, requestId: request.id });
        }
      } else {
        const settings = config.decision;
        if (record.operatorRetryId === request.id) { /* A crash after the record write can safely acknowledge the same request. */ }
        else if (!settings?.enabled || record.requestedModel !== settings.model || taskId(record) !== request.recordDigest
          || !['error', 'deferred'].includes(record.status) || record.attempts >= settings.maxAttempts)
          rejection = 'Decision retry evidence changed or its original attempt allowance is exhausted.';
        else {
          record.retryable = true; record.retryAfter = undefined; record.operatorRetryId = request.id;
          record.updatedAt = request.createdAt; await store.save(record);
        }
        if (!rejection && services && record.subject?.issue && config.service)
          await services.enqueue({ ...pollEvent(config.repository, 'decision-request:' + request.id, 'issue', record.subject.issue), source: 'operator' }, config.service.queue.maxPending);
      }
    }
    const receipt = { status: rejection ? 'rejected' as const : 'applied' as const, at: new Date().toISOString(),
      reason: rejection ?? 'Operator request applied at a controller boundary.', resultId };
    await governance.receipt(request.id, receipt); result.push({ id: request.id, status: receipt.status });
  }
  return result;
}
