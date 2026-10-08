import type { Candidate } from '../domain/candidate.js';
import { taskId } from '../domain/identity.js';
import type { ServiceConfig } from '../domain/service.js';
import type { ProgressGitHub, ServiceStore } from '../ports/service.js';
import { throwIfAborted } from '../shared/control.js';

export async function queueProgress(store: ServiceStore, repository: string, number: number, status: string,
  evidence: { candidate?: string; goal?: string; report?: string; commit?: string; url?: string } = {}) {
  const id = taskId(['progress', repository, number]), marker = `<!-- repopilot-progress:${id} -->`;
  const lines = [marker, '### RepoPilot progress', '', `Status: **${status}**`];
  for (const [label, value] of [['Candidate', evidence.candidate], ['Goal', evidence.goal], ['Report', evidence.report]] as const)
    if (value && /^[a-f0-9]{24}$/.test(value)) lines.push(`${label}: \`${value}\``);
  if (evidence.commit && /^[a-f0-9]{40}$/.test(evidence.commit))
    lines.push(`Pinned commit: [${evidence.commit.slice(0, 7)}](https://github.com/${repository}/commit/${evidence.commit})`);
  if (evidence.url?.startsWith(`https://github.com/${repository}/pull/`) && /\/pull\/\d+$/.test(evidence.url))
    lines.push(`Repair proposal: [draft PR](${evidence.url})`);
  lines.push('', 'Verification evidence is retained in the local RepoPilot data directory.');
  const body = lines.join('\n'), digest = taskId(body);
  const previous = (await store.progress(repository)).find(item => item.id === id);
  if (previous?.digest === digest) return;
  await store.saveProgress({ schemaVersion: 1, id, repository, number, marker, body, digest,
    deliveredDigest: previous?.deliveredDigest, commentId: previous?.commentId, attempts: 0, updatedAt: new Date().toISOString() });
}
export function queueCandidateProgress(store: ServiceStore, candidate: Candidate, reproducing = false, url?: string) {
  if (!candidate.issue) return Promise.resolve();
  const statuses: Record<Candidate['status'], string> = { observed: 'Queued for reproduction', stale: 'Inputs changed; previous approval is invalid',
    reproduced: 'Reproduced; awaiting execution approval', approved: 'Approved for bounded execution', running: 'Implementation and verification in progress',
    completed: 'Verification completed', blocked: 'Blocked; inspect local evidence' };
  return queueProgress(store, candidate.repository, candidate.issue, reproducing ? 'Reproducing on the pinned commit' : statuses[candidate.status],
    { candidate: candidate.id, goal: candidate.goalId, report: candidate.reproduction?.reportId, commit: candidate.commit, url });
}

export async function flushProgress(store: ServiceStore, repository: string, github: ProgressGitHub,
  config: ServiceConfig, signal: AbortSignal, onError: (message: string) => void) {
  if (!config.progress) return;
  const control = await store.control(repository);
  let attempted = 0;
  for (const message of await store.progress(repository)) {
    if (attempted >= config.queue.maxBatch) break;
    throwIfAborted(signal);
    if (message.digest === message.deliveredDigest) continue;
    if (control?.action === 'resume' && message.resumeId !== control.id) {
      message.resumeId = control.id; message.attempts = 0; message.retryAfter = undefined;
    }
    if (message.attempts >= config.queue.maxAttempts || message.retryAfter && Date.parse(message.retryAfter) > Date.now()) continue;
    attempted++;
    message.attempts++; await store.saveProgress(message);
    try {
      message.commentId = await github.syncProgress(message.number, message.marker, message.body);
      message.deliveredDigest = message.digest; message.error = undefined; message.retryAfter = undefined;
    } catch (error) {
      throwIfAborted(signal);
      message.error = 'GitHub progress delivery failed; inspect the controller log.';
      message.retryAfter = new Date(Date.now() + Math.min(300000, 1000 * 2 ** message.attempts)).toISOString();
      onError(`Progress on #${message.number} could not be delivered: ${String(error).slice(0, 1000)}`);
    }
    message.updatedAt = new Date().toISOString(); await store.saveProgress(message);
  }
}
