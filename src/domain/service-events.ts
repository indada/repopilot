import { z } from 'zod';
import { taskId } from './identity.js';
import type { ServiceEvent } from './service.js';

const number = z.number().int().positive();
const payloadSchema = z.object({ repository: z.object({ full_name: z.string() }), action: z.string().optional(),
  issue: z.object({ number, pull_request: z.unknown().optional() }).optional(),
  pull_request: z.object({ number }).optional(), comment: z.object({ body: z.string() }).optional() });

/** Payloads are wake-up hints. Only fresh API reads may establish authorization or executable inputs. */
export function webhookTarget(event: string, payload: unknown, repository: string): Pick<ServiceEvent, 'kind' | 'key' | 'number'> | undefined {
  const body = payloadSchema.parse(payload);
  if (body.repository.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error('Webhook repository mismatch.');
  if (event === 'ping') return undefined;
  if (event === 'issues' && ['opened', 'edited', 'labeled', 'unlabeled', 'closed', 'reopened', 'deleted', 'transferred'].includes(body.action ?? '') && body.issue)
    return { kind: 'issue', key: 'issue:' + body.issue.number, number: body.issue.number };
  if (event === 'issue_comment' && ['created', 'edited', 'deleted'].includes(body.action ?? '') && body.issue) {
    if (body.comment?.body.startsWith('<!-- repopilot-progress:')) return undefined;
    const kind = body.issue.pull_request ? 'pull' : 'issue';
    return { kind, key: kind + ':' + body.issue.number, number: body.issue.number };
  }
  if (['pull_request', 'pull_request_review', 'pull_request_review_comment'].includes(event) && body.pull_request
    && ['opened', 'edited', 'synchronize', 'closed', 'reopened', 'ready_for_review', 'converted_to_draft', 'labeled', 'unlabeled', 'submitted', 'dismissed', 'created', 'deleted'].includes(body.action ?? ''))
    return { kind: 'pull', key: 'pull:' + body.pull_request.number, number: body.pull_request.number };
  if ((event === 'check_run' || event === 'check_suite') && ['completed', 'rerequested', 'requested'].includes(body.action ?? '')
    || event === 'status' || event === 'push' || event === 'workflow_run' && body.action === 'completed')
    return { kind: 'reconcile', key: 'reconcile' };
  return undefined;
}

export function pollEvent(repository: string, delivery: string, kind: ServiceEvent['kind'], number?: number, time = Date.now()): ServiceEvent {
  const key = kind === 'reconcile' ? kind : kind + ':' + number;
  return { schemaVersion: 1, id: taskId([repository, delivery]), repository, delivery,
    digest: taskId([kind, number]), source: 'poll', event: 'reconcile', receivedAt: new Date(time).toISOString(), kind, key, number };
}
