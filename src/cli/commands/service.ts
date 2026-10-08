import { randomUUID } from 'node:crypto';
import type { Config } from '../../domain/config.js';
import { pollEvent } from '../../domain/service-events.js';
import type { ServiceStore } from '../../ports/service.js';
import type { CandidateStore } from '../../ports/candidate.js';
import { budgetStatus } from '../../application/service-budget.js';
import { serviceSettings } from '../../application/service.js';
import type { CliValues } from '../args.js';
import type { Output } from '../runtime.js';

export async function inspectService(command: string, action: string | undefined, id: string | undefined, values: CliValues,
  config: Config, services: ServiceStore, candidates: CandidateStore, output: Output): Promise<boolean> {
  if (!['service', 'events'].includes(command)) return false;
  const settings = serviceSettings(config), emit = (value: unknown) => output.write(JSON.stringify(value, null, 2));
  if (command === 'service') {
    if (action === 'pause' || action === 'resume') {
      await services.requestControl(config.repository, action); emit({ requested: action, repository: config.repository }); return true;
    }
    if (action === 'approve') {
      if (!id || !/^[a-f0-9]{24}$/.test(id) || !values.expected || !/^[a-f0-9]{24}$/.test(values.expected))
        throw new Error('Use service approve CANDIDATE_ID --expected EVIDENCE_DIGEST.');
      const candidate = await candidates.read(id);
      if (!candidate || candidate.repository !== config.repository || candidate.kind !== 'issue' || !candidate.issue
        || candidate.status !== 'reproduced' || candidate.evidenceDigest !== values.expected)
        throw new Error('Approval requires a reproduced Issue with the inspected evidence digest.');
      const event = { ...pollEvent(config.repository, 'approve:' + randomUUID(), 'issue', candidate.issue),
        source: 'operator' as const, approval: { candidateId: id, evidenceDigest: values.expected } };
      await services.enqueue(event, settings.queue.maxPending); emit({ queued: event.id, approval: event.approval }); return true;
    }
    if (action !== 'status') throw new Error('Use service status|pause|resume|approve.');
    const events = await services.events(config.repository), control = await services.control(config.repository);
    const progress = await services.progress(config.repository), ledger = await services.ledger(config.repository);
    emit({ repository: config.repository, budget: budgetStatus(ledger, settings, Date.now(), config.agent.enabled ? config.agent.maxTokens : 0), requestedControl: control,
      events: { pending: events.filter(item => !item.receipt || item.receipt.status === 'pending').length,
        processing: events.filter(item => item.receipt?.status === 'processing').length,
        dead: events.filter(item => item.receipt?.status === 'dead').length },
      feedback: { pending: progress.filter(item => item.digest !== item.deliveredDigest).length,
        blocked: progress.filter(item => item.digest !== item.deliveredDigest && item.attempts >= settings.queue.maxAttempts).length } });
    return true;
  }
  const entries = await services.events(config.repository);
  if (action === 'retry') {
    if (!id || !/^[a-f0-9]{24}$/.test(id)) throw new Error('Event ID required.');
    const record = entries.find(item => item.event.id === id);
    if (!record || record.receipt?.status !== 'dead') throw new Error('Only dead events can be retried explicitly.');
    const event = { ...pollEvent(config.repository, 'retry:' + id + ':' + randomUUID(), record.event.kind, record.event.number),
      source: 'operator' as const, approval: record.event.approval };
    await services.enqueue(event, settings.queue.maxPending); emit({ queued: event.id, retryOf: id }); return true;
  }
  if (action !== 'list') throw new Error('Use events list|retry.');
  const limit = Number(values.limit ?? 20), offset = Number(values.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid event pagination.');
  if (values.status && !['pending', 'processing', 'completed', 'dead'].includes(values.status)) throw new Error('Invalid event status.');
  const filtered = entries.filter(item => !values.status || (item.receipt?.status ?? 'pending') === values.status);
  emit({ total: filtered.length, offset, events: filtered.slice(offset, offset + limit) }); return true;
}
