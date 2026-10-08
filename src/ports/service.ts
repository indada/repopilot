import type { EventReceipt, ProgressMessage, QueuedEvent, ServiceControl, ServiceEvent, ServiceLedger } from '../domain/service.js';

export interface ServiceStore {
  enqueue(event: ServiceEvent, maxPending: number): Promise<'created' | 'duplicate'>;
  events(repository: string): Promise<QueuedEvent[]>;
  receipt(id: string, value: EventReceipt): Promise<void>;
  prune(repository: string, before: string): Promise<number>;
  ledger(repository: string): Promise<ServiceLedger | undefined>;
  saveLedger(value: ServiceLedger): Promise<void>;
  control(repository: string): Promise<ServiceControl | undefined>;
  requestControl(repository: string, action: 'pause' | 'resume'): Promise<void>;
  progress(repository: string): Promise<ProgressMessage[]>;
  saveProgress(value: ProgressMessage): Promise<void>;
}
export interface ProgressGitHub {
  syncProgress(number: number, marker: string, body: string): Promise<number>;
}
export interface ModelCallReservation { settle(tokens?: number): Promise<void>; }
export interface ModelCallBudget { reserve(): Promise<ModelCallReservation>; }
