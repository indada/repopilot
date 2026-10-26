import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { compareDecisions, evaluateDecisions, evaluationEligibility, exportDecisionSuite, sweepDecisionThresholds } from '../../application/decision-evaluation.js';
import { policyPreview } from '../../application/decision-policies.js';
import { processDecisionRequests } from '../../application/decision-requests.js';
import { decisionEvidenceDigest, governanceRequestSchema, policyVersion, reviewSpecSchema, type GovernanceRequest } from '../../domain/decision-governance.js';
import type { Config } from '../../domain/config.js';
import { taskId } from '../../domain/identity.js';
import type { DecisionGovernanceStore } from '../../ports/decision-governance.js';
import type { DecisionStore } from '../../ports/decision.js';
import type { ServiceStore } from '../../ports/service.js';
import type { CliValues } from '../args.js';
import type { Output } from '../runtime.js';

interface GovernanceCli { config: Config; store: DecisionStore; governance: DecisionGovernanceStore; services: ServiceStore; output: Output; }
const json = async (path: string | undefined) => {
  if (!path) throw new Error('An explicit --spec JSON file is required.');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
};
const id = (value: string | undefined) => { if (!/^[a-f0-9]{24}$/.test(value ?? '')) throw new Error('A valid 24-character evidence ID is required.'); return value!; };
function page<T>(values: T[], flags: CliValues) {
  const limit = Number(flags.limit ?? 20), offset = Number(flags.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid governance pagination.');
  return { total: values.length, offset, entries: values.slice(offset, offset + limit) };
}
function requestBase(config: Config) {
  return { schemaVersion: 1 as const, repository: config.repository, id: taskId(['operator', config.repository, randomUUID()]), createdAt: new Date().toISOString() };
}
async function enqueue(request: GovernanceRequest, d: GovernanceCli) {
  await d.governance.enqueue(governanceRequestSchema.parse(request), d.config.service?.queue.maxPending ?? 1000);
  d.output.write(JSON.stringify({ queued: request.id, action: request.action, execution: 'pending controller processing' }));
}
async function policyInRepository(policyId: string | undefined, d: GovernanceCli) {
  const policy = await d.governance.policy(id(policyId));
  if (!policy || policy.repository !== d.config.repository) throw new Error('Policy not found in this repository.'); return policy;
}

export async function inspectDecisionGovernance(command: string, action: string | undefined, recordId: string | undefined, values: CliValues, d: GovernanceCli): Promise<boolean> {
  const emit = (value: unknown) => d.output.write(JSON.stringify(value, null, 2));
  if (command === 'policies') {
    if (action === 'list') { emit(page(await d.governance.policies(d.config.repository), values)); return true; }
    if (action === 'show') { emit(await policyInRepository(recordId, d)); return true; }
    if (action === 'status') { emit(await d.governance.policyState(d.config.repository) ?? { revision: 0, history: [] }); return true; }
    if (action === 'activate' || action === 'rollback') {
      if (!d.config.decision) throw new Error('Configure decision before managing policy.');
      if (action === 'activate') id(recordId);
      if (action === 'rollback' && recordId) throw new Error('Rollback selects the previous policy; do not supply a target.');
      const preview = await policyPreview(d.config.repository, d.config.decision, d.governance, action, recordId, values.evaluation, d.store);
      if (!values.apply) {
        if (values.expected) throw new Error('--expected requires --apply.'); emit(preview); return true;
      }
      if (!preview.eligible || preview.token !== values.expected) throw new Error('Inspect an eligible current policy preview and use --apply --expected TOKEN.');
      await enqueue({ ...requestBase(d.config), action, policyId: recordId, evaluationId: values.evaluation, expected: preview.token }, d); return true;
    }
    if (action !== 'save') throw new Error('Use policies save|list|show|status|activate|rollback.');
    return false;
  }
  if (command !== 'decisions') return false;
  if (action === 'reviews') { emit(page(await d.governance.reviews(d.config.repository), values)); return true; }
  if (action === 'outcomes') {
    const observations = await d.governance.observations(d.config.repository);
    emit(page(recordId ? observations.filter(value => value.decisionId === id(recordId)) : observations, values)); return true;
  }
  if (action === 'requests') { emit(page(await d.governance.requests(d.config.repository), values)); return true; }
  if (action === 'evaluations') { emit(page(await d.governance.evaluations(d.config.repository), values)); return true; }
  if (action === 'review' || action === 'retry' && values.queue) {
    const record = await d.store.read(id(recordId));
    if (!record || record.repository !== d.config.repository || record.inputDigest !== values.expected)
      throw new Error('Operator request requires --expected INPUT_DIGEST from the current decision.');
    if (action === 'review') await enqueue({ ...requestBase(d.config), action, decisionId: record.id, inputDigest: record.inputDigest,
      evidenceDigest: decisionEvidenceDigest(record), labels: reviewSpecSchema.parse(await json(values.spec)) }, d);
    else await enqueue({ ...requestBase(d.config), action, decisionId: record.id, inputDigest: record.inputDigest, recordDigest: taskId(record) }, d);
    return true;
  }
  if (action === 'suite') {
    const suite = await exportDecisionSuite(d.config.repository, values.suite ?? '', d.store, d.governance);
    if (values.output) { await writeFile(values.output, JSON.stringify(suite, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); emit({ saved: values.output, cases: suite.cases.length }); }
    else emit(suite); return true;
  }
  if (action === 'compare') {
    const baseline = await d.governance.evaluation(id(values.baseline)), candidate = await d.governance.evaluation(id(values.candidate));
    if (!baseline || !candidate || baseline.repository !== d.config.repository || candidate.repository !== d.config.repository)
      throw new Error('Evaluation not found in this repository.');
    emit(compareDecisions(baseline, candidate)); return true;
  }
  if (action === 'sweep') {
    if (!d.config.decision) throw new Error('Decision configuration is required.');
    emit(await sweepDecisionThresholds(await json(values.spec), d.config.repository, d.config.decision,
      await policyInRepository(values.policy, d), d.store, d.governance)); return true;
  }
  return false;
}

export async function executeDecisionGovernance(command: string, action: string | undefined, values: CliValues, d: GovernanceCli): Promise<number | undefined> {
  if (command === 'policies' && action === 'save') {
    const policy = policyVersion(d.config.repository, await json(values.spec));
    await d.governance.savePolicy(policy); d.output.write(JSON.stringify(policy, null, 2)); return 0;
  }
  if (command !== 'decisions') return;
  if (action === 'process') { d.output.write(JSON.stringify(await processDecisionRequests(d.config, d.store, d.governance, d.services))); return 0; }
  if (action !== 'replay') return;
  if (!d.config.decision) throw new Error('Decision configuration is required.');
  const evaluated = await evaluateDecisions(await json(values.spec), d.config.repository, d.config.decision,
    await policyInRepository(values.policy, d), d.store, d.governance);
  await d.governance.saveEvaluation(evaluated);
  const eligibility = evaluationEligibility(evaluated, d.config.decision);
  d.output.write(JSON.stringify({ ...evaluated, promotion: eligibility, providerCalls: 0 }, null, 2)); return eligibility.eligible ? 0 : 1;
}
