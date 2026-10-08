import { randomUUID } from 'node:crypto';
import type { ServiceConfig, ServiceLedger } from '../domain/service.js';
import type { ModelCallBudget, ServiceStore } from '../ports/service.js';
import { AutomationPausedError } from '../shared/control.js';

export function budgetStatus(ledger: ServiceLedger | undefined, config: ServiceConfig, time = Date.now(), tokenReservation = 0) {
  const day = new Date(time).toISOString().slice(0, 10), used = ledger?.days[day] ?? { calls: 0, tokens: 0, tasks: 0 };
  const reasons: string[] = [];
  if (ledger?.operatorPaused) reasons.push('Service is paused by the operator.');
  if (ledger?.circuitReason) reasons.push(ledger.circuitReason);
  if (used.calls >= config.limits.dailyCalls) reasons.push('Daily model call limit reached.');
  if (used.tokens >= config.limits.dailyTokens) reasons.push('Daily model token limit reached.');
  else if (used.tokens + tokenReservation > config.limits.dailyTokens)
    reasons.push('Daily token allowance cannot fit a conservative model-call reservation.');
  if (used.tasks >= config.limits.dailyTasks) reasons.push('Daily task limit reached.');
  return { day, used, limits: config.limits, paused: reasons.length > 0, reasons,
    failures: ledger?.failures ?? 0, unknownCalls: Object.values(ledger?.reservations ?? {}).filter(item => item.day === day).length };
}

/** Shared by every role and execution fork; each reservation is saved before the container starts. */
export class ServiceBudget implements ModelCallBudget {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private store: ServiceStore, private repository: string, private config: ServiceConfig,
    private tokenReservation: number, private clock: () => number = Date.now) {}
  private update<T>(operation: (ledger: ServiceLedger) => Promise<T> | T): Promise<T> {
    const result = this.tail.then(async () => {
      const previous = await this.store.ledger(this.repository);
      const ledger = previous ?? { schemaVersion: 1, repository: this.repository,
        days: {}, reservations: {}, failures: 0, operatorPaused: false };
      let persisted = previous ? JSON.stringify(previous) : undefined;
      const saveChanged = async () => {
        const value = JSON.stringify(ledger);
        if (value !== persisted) { await this.store.saveLedger(ledger); persisted = value; }
      };
      const control = await this.store.control(this.repository);
      if (control && ledger.controlId !== control.id) {
        ledger.operatorPaused = control.action === 'pause'; ledger.controlId = control.id;
        if (control.action === 'resume') { ledger.failures = 0; ledger.circuitReason = undefined; }
      }
      const day = new Date(this.clock()).toISOString().slice(0, 10);
      ledger.days[day] ??= { calls: 0, tokens: 0, tasks: 0 };
      const keepAfter = new Date(this.clock() - 14 * 86400000).toISOString().slice(0, 10);
      for (const old of Object.keys(ledger.days)) if (old < keepAfter) delete ledger.days[old];
      for (const [id, reservation] of Object.entries(ledger.reservations)) if (reservation.day < keepAfter) delete ledger.reservations[id];
      // Persist operator intent even when the following admission is rejected.
      await saveChanged();
      const value = await operation(ledger); await saveChanged(); return value;
    });
    this.tail = result.catch(() => undefined); return result;
  }
  status() { return this.update(ledger => budgetStatus(ledger, this.config, this.clock(), this.tokenReservation)); }
  private check(ledger: ServiceLedger, includeTasks: boolean) {
    const status = budgetStatus(ledger, this.config, this.clock(), this.tokenReservation);
    const reasons = status.reasons.filter(reason => includeTasks || reason !== 'Daily task limit reached.');
    if (reasons.length) throw new AutomationPausedError(reasons.join(' '));
    return status;
  }
  startTask() {
    return this.update(ledger => {
      const status = this.check(ledger, true);
      ledger.days[status.day]!.tasks++;
    });
  }
  async reserve() {
    const id = randomUUID();
    await this.update(ledger => {
      const status = this.check(ledger, false);
      ledger.days[status.day]!.calls++; ledger.days[status.day]!.tokens += this.tokenReservation;
      ledger.reservations[id] = { day: status.day, tokens: this.tokenReservation, settled: false };
    });
    return { settle: (tokens?: number) => this.update(ledger => {
      const reservation = ledger.reservations[id];
      if (!reservation || reservation.settled) return;
      if (tokens !== undefined) {
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid model token usage.');
        const day = ledger.days[reservation.day];
        if (day) day.tokens += tokens - reservation.tokens;
        delete ledger.reservations[id];
      } else reservation.settled = true;
    }) };
  }
  outcome(result: 'success' | 'failure' | 'neutral') {
    return this.update(ledger => {
      if (result === 'success') ledger.failures = 0;
      if (result === 'failure' && ++ledger.failures >= this.config.limits.failureThreshold)
        ledger.circuitReason = 'Consecutive execution or verification failures opened the service circuit; inspect evidence and resume explicitly.';
    });
  }
}
