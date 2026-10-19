import type { DecisionFailure, DecisionLedger, DecisionRecord, DecisionResult, DecisionSubject, DecisionSummary } from '../domain/decision.js';

export interface DecisionModel {
  validate?(subject: DecisionSubject): void;
  evaluate(subject: DecisionSubject, signal?: AbortSignal): Promise<DecisionResult>;
}
export interface DecisionEvaluator {
  evaluate(subject: DecisionSubject, signal: AbortSignal): Promise<{ summary: DecisionSummary; attempted: boolean }>;
}
export interface DecisionStore {
  read(id: string): Promise<DecisionRecord | undefined>;
  list(repository: string): Promise<DecisionRecord[]>;
  save(record: DecisionRecord): Promise<void>;
  ledger(repository: string): Promise<DecisionLedger | undefined>;
  saveLedger(ledger: DecisionLedger): Promise<void>;
}
export class DecisionModelError extends Error {
  constructor(readonly failure: DecisionFailure, readonly retryable: boolean, readonly retryAfterMs = 0) {
    super(`Jev decision request failed: ${failure}.`);
  }
}
