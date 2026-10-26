import { randomUUID } from 'node:crypto';
import { DECISION_QUESTION_VERSION, decisionIdentity, summarizeDecision } from '../domain/decision-policy.js';
import type { DecisionConfig, DecisionLedger, DecisionResult, DecisionSubject } from '../domain/decision.js';
import { DecisionModelError, type DecisionEvaluator, type DecisionModel, type DecisionStore } from '../ports/decision.js';
import { taskId } from '../domain/identity.js';

export function decisionBudgetStatus(ledger: DecisionLedger | undefined, config: DecisionConfig, time = Date.now()) {
  const day = new Date(time).toISOString().slice(0, 10), used = ledger?.days[day] ?? { calls: 0, tokens: 0 };
  return { day, used, limits: config.limits,
    available: used.calls < config.limits.dailyCalls && used.tokens + config.limits.tokensPerCall <= config.limits.dailyTokens,
    unknownCalls: Object.values(ledger?.reservations ?? {}).filter(item => item.day === day).length };
}

/** Serial admission and cached records prevent concurrent hints from paying twice for the same evidence. */
export class CandidateDecisionEvaluator implements DecisionEvaluator {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private repository: string, private config: DecisionConfig, private store: DecisionStore,
    private model: DecisionModel, private clock: () => number = Date.now,
    private resolvePolicy?: () => Promise<DecisionConfig>) {}
  evaluate(subject: DecisionSubject, signal: AbortSignal) {
    const operation = this.tail.then(() => this.execute(subject, signal));
    this.tail = operation.catch(() => undefined); return operation;
  }
  private async execute(subject: DecisionSubject, signal: AbortSignal) {
    signal.throwIfAborted();
    const config = this.resolvePolicy ? await this.resolvePolicy() : this.config;
    if (config.model !== this.config.model) throw new Error('Managed policy cannot change the provider model.');
    if (!this.config.enabled) throw new Error('Decision evaluation requires decision.enabled=true.');
    if (subject.repository !== this.repository) throw new Error('Decision repository mismatch.');
    const identity = decisionIdentity(subject, this.config.model), at = new Date(this.clock()).toISOString();
    let record = await this.store.read(identity.id);
    if (record && (record.repository !== this.repository || record.inputDigest !== identity.inputDigest
      || record.candidateId !== subject.candidateId || record.evidenceDigest !== subject.evidenceDigest
      || record.requestedModel !== this.config.model || record.questionVersion !== DECISION_QUESTION_VERSION))
      throw new Error('Decision evidence identity mismatch.');
    if (record?.status === 'evaluated') return { summary: summarizeDecision(record, config), attempted: false };
    if (record?.status === 'running') {
      record.status = 'error'; record.failure = 'interrupted'; record.retryable = true;
      record.retryAfter = new Date(Date.parse(record.updatedAt)
        + this.config.retrySeconds * 1000 * 2 ** Math.max(0, record.attempts - 1)).toISOString();
      record.updatedAt = at; await this.store.save(record);
    }
    if (record && (record.attempts >= this.config.maxAttempts || record.retryable === false
      || record.failure !== 'budget_exhausted' && record.retryAfter && Date.parse(record.retryAfter) > this.clock()))
      return { summary: summarizeDecision(record, config), attempted: false };
    record ??= { schemaVersion: 1, ...identity, repository: this.repository, candidateId: subject.candidateId,
      evidenceDigest: subject.evidenceDigest, questionVersion: DECISION_QUESTION_VERSION, requestedModel: this.config.model,
      intent: subject.intent, status: 'running', attempts: 0, createdAt: at, updatedAt: at,
      subject: { issue: subject.issue, commit: subject.commit, branch: subject.branch, requestDigest: taskId(subject.request) } };
    try { this.model.validate?.(subject); }
    catch (error) {
      if (!(error instanceof DecisionModelError)) throw error;
      record.status = 'error'; record.failure = error.failure; record.retryable = false; record.retryAfter = undefined;
      record.updatedAt = at; await this.store.save(record);
      return { summary: summarizeDecision(record, config), attempted: false };
    }
    const ledger = await this.store.ledger(this.repository) ?? { schemaVersion: 1, repository: this.repository, days: {}, reservations: {} };
    const budget = decisionBudgetStatus(ledger, this.config, this.clock());
    if (!budget.available) {
      record.status = 'deferred'; record.failure = 'budget_exhausted'; record.retryable = true; record.updatedAt = at;
      record.retryAfter = new Date(Date.parse(budget.day + 'T00:00:00Z') + 86400000).toISOString();
      await this.store.save(record);
      return { summary: summarizeDecision(record, config), attempted: false };
    }
    // A crash between reservation and record write is conservatively charged; no call starts before both writes.
    const reservation = randomUUID();
    const used = ledger.days[budget.day] ??= { calls: 0, tokens: 0 };
    used.calls++; used.tokens += this.config.limits.tokensPerCall;
    ledger.reservations[reservation] = { day: budget.day, tokens: this.config.limits.tokensPerCall };
    await this.store.saveLedger(ledger);
    record.status = 'running'; record.attempts++; record.retryAfter = undefined; record.failure = undefined;
    record.updatedAt = at; await this.store.save(record);
    let result: DecisionResult | undefined;
    const started = this.clock();
    try {
      signal.throwIfAborted();
      result = await this.model.evaluate(subject, signal);
    } catch (error) {
      record.status = 'error'; record.failure = signal.aborted ? 'interrupted'
        : error instanceof DecisionModelError ? error.failure : 'transport';
      record.retryable = signal.aborted || !(error instanceof DecisionModelError) || error.retryable;
      const delay = Math.max(this.config.retrySeconds * 1000 * 2 ** Math.max(0, record.attempts - 1),
        error instanceof DecisionModelError ? error.retryAfterMs : 0);
      record.retryAfter = record.retryable && record.attempts < this.config.maxAttempts
        ? new Date(this.clock() + delay).toISOString() : undefined;
    }
    // Persistence failures are fatal, not provider fallbacks: do not continue with incomplete accounting.
    if (result) {
      used.tokens += result.usage.input_tokens + result.usage.output_tokens - this.config.limits.tokensPerCall;
      delete ledger.reservations[reservation]; await this.store.saveLedger(ledger);
      record.status = 'evaluated'; record.result = result; record.retryable = false;
    }
    record.elapsedMs = (record.elapsedMs ?? 0) + Math.max(0, this.clock() - started);
    record.updatedAt = new Date(this.clock()).toISOString(); await this.store.save(record);
    signal.throwIfAborted();
    return { summary: summarizeDecision(record, config), attempted: true };
  }
}
