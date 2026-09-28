import { orderCandidates } from '../../domain/candidate.js';
import type { Config } from '../../domain/config.js';
import type { CandidateStore } from '../../ports/candidate.js';
import { approveCandidate, refreshCandidates, reproduceCandidate, runCandidate, type CandidateDependencies } from '../../application/candidates.js';
import type { CliValues } from '../args.js';
import type { Output } from '../runtime.js';

const emit = (output: Output, value: unknown) => output.write(JSON.stringify(value, null, 2));
export function validateCandidateCommand(action: string | undefined, id: string | undefined, values: CliValues) {
  if (!['refresh', 'list', 'show', 'reproduce', 'approve', 'run'].includes(action ?? '')) throw new Error('Unknown candidates action.');
  if (!['refresh', 'list'].includes(action!) && !id) throw new Error('Candidate ID is required.');
  if (id && !/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid candidate ID.');
  if (action === 'approve' && !/^[a-f0-9]{24}$/.test(values.expected ?? ''))
    throw new Error('Approval requires --expected EVIDENCE_DIGEST from candidates show.');
}
export async function inspectCandidates(action: string | undefined, id: string | undefined,
  values: CliValues, config: Config, candidates: CandidateStore, output: Output): Promise<boolean> {
  if (action === 'list') {
    const limit = Number(values.limit ?? 20), offset = Number(values.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0)
      throw new Error('Invalid pagination.');
    const entries = orderCandidates((await candidates.list()).filter(item => item.repository === config.repository));
    emit(output, { total: entries.length, offset, candidates: entries.slice(offset, offset + limit) }); return true;
  }
  if (action === 'show') {
    const candidate = await candidates.read(id!);
    if (!candidate || candidate.repository !== config.repository) throw new Error('Candidate not found in this repository.');
    emit(output, candidate); return true;
  }
  return false;
}
export async function executeCandidates(action: string, id: string | undefined, values: CliValues,
  d: CandidateDependencies, output: Output): Promise<number> {
  if (action === 'refresh') { emit(output, await refreshCandidates(d)); return 0; }
  const candidate = action === 'reproduce' ? await reproduceCandidate(id!, d)
    : action === 'approve' ? await approveCandidate(id!, values.expected!, d) : await runCandidate(id!, d);
  emit(output, candidate);
  return ['blocked', 'stale'].includes(candidate.status) ? 1 : 0;
}
