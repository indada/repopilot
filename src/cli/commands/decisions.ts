import type { Config } from '../../domain/config.js';
import { decisionBudgetStatus } from '../../application/decisions.js';
import { evaluateCandidate, type CandidateDependencies } from '../../application/candidates.js';
import type { DecisionStore } from '../../ports/decision.js';
import type { CliValues } from '../args.js';
import type { Output } from '../runtime.js';

export function validateDecisionCommand(action: string | undefined, id: string | undefined, values: CliValues = {}) {
  if (!['list', 'show', 'status', 'evaluate', 'retry'].includes(action ?? '')) throw new Error('Use decisions list|show|status|evaluate|retry.');
  if (['show', 'evaluate', 'retry'].includes(action!) && !/^[a-f0-9]{24}$/.test(id ?? ''))
    throw new Error('Use a decision ID for show or candidate ID for evaluate.');
  if (['list', 'status'].includes(action!) && id) throw new Error('This decision action does not accept an ID.');
  if (action === 'retry' && !/^[a-f0-9]{24}$/.test(values.expected ?? '')) throw new Error('Retry requires --expected INPUT_DIGEST from decisions show.');
}
export async function inspectDecisions(action: string | undefined, id: string | undefined, values: CliValues,
  config: Config, store: DecisionStore, output: Output): Promise<boolean> {
  const emit = (value: unknown) => output.write(JSON.stringify(value, null, 2));
  if (action === 'show') {
    const record = await store.read(id!);
    if (!record || record.repository !== config.repository) throw new Error('Decision not found in this repository.');
    emit(record); return true;
  }
  if (action === 'status') {
    const settings = config.decision;
    emit({ repository: config.repository, enabled: settings?.enabled ?? false, mode: settings?.mode,
      model: settings?.model, budget: settings ? decisionBudgetStatus(await store.ledger(config.repository), settings) : undefined });
    return true;
  }
  if (action !== 'list') return false;
  const limit = Number(values.limit ?? 20), offset = Number(values.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid decision pagination.');
  if (values.status && !['running', 'evaluated', 'error', 'deferred'].includes(values.status)) throw new Error('Invalid decision status.');
  const records = (await store.list(config.repository)).filter(record => !values.status || record.status === values.status);
  emit({ total: records.length, offset, decisions: records.slice(offset, offset + limit) }); return true;
}
export async function executeDecision(id: string, d: CandidateDependencies, output: Output) {
  const result = await evaluateCandidate(id, d); output.write(JSON.stringify(result, null, 2));
  return result.candidate.decision?.status === 'evaluated' ? 0 : 1;
}
export async function retryDecision(id: string, expected: string, config: Config, store: DecisionStore, output: Output) {
  const record = await store.read(id), settings = config.decision;
  if (!settings?.enabled || !record || record.repository !== config.repository || record.inputDigest !== expected
    || record.requestedModel !== settings.model) throw new Error('Decision retry does not match the inspected repository, input digest or model.');
  if (!['error', 'deferred'].includes(record.status) || record.attempts >= settings.maxAttempts)
    throw new Error('Only failed or deferred decisions within their original attempt allowance can retry.');
  record.retryable = true; record.retryAfter = undefined; record.updatedAt = new Date().toISOString();
  await store.save(record); output.write(JSON.stringify({ id, retryAllowed: true, attempts: record.attempts })); return 0;
}
