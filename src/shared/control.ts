import { setTimeout as delay } from 'node:timers/promises';

export class StaleTaskError extends Error { constructor() { super('Pull request inputs changed while the task was running.'); } }
export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message); }
}
/** Service policy defers execution without spending a candidate's failure allowance. */
export class AutomationPausedError extends RetryableError {}
export interface RetryOptions { attempts: number; baseDelayMs: number; maxDelayMs: number; }
export const pause = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal });
export function throwIfAborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions, signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<unknown> = pause): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try { return await operation(); }
    catch (error) {
      throwIfAborted(signal);
      if (!(error instanceof RetryableError) || attempt >= options.attempts || error.retryAfterMs > options.maxDelayMs) throw error;
      await wait(Math.min(options.maxDelayMs, Math.max(error.retryAfterMs, options.baseDelayMs * 2 ** (attempt - 1))), signal);
    }
  }
}
/** Poll independently while work is pending; never leave an unobserved timer/promise. */
export async function withFreshness<T>(work: (signal: AbortSignal) => Promise<T>, fresh: () => Promise<boolean>,
  intervalMs: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel(); else parent?.addEventListener('abort', cancel, { once: true });
  const monitoring = (async () => {
    while (!controller.signal.aborted) {
      try {
        await pause(intervalMs, controller.signal);
        if (!await fresh()) controller.abort(new StaleTaskError());
      } catch (error) { if (!controller.signal.aborted) controller.abort(error); }
    }
  })();
  try { return await work(controller.signal); }
  finally { controller.abort(); parent?.removeEventListener('abort', cancel); await monitoring; }
}
