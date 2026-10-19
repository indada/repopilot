import { z } from 'zod';
import { decisionQuestions, urgencyLevels } from '../../domain/decision-policy.js';
import type { DecisionConfig, DecisionResult, DecisionSubject } from '../../domain/decision.js';
import { DecisionModelError, type DecisionModel } from '../../ports/decision.js';

const probability = z.number().min(0).max(1);
const kindProbabilities = z.object({ bugfix: probability, feature: probability, question: probability, unclear: probability }).strict();
const riskProbabilities = z.object({ low: probability, medium: probability, high: probability, unknown: probability }).strict();
const scoreProbabilities = z.object({ '0': probability, '1': probability, '2': probability, '3': probability }).strict();
const responseSchema = z.object({
  model: z.string(),
  answers: z.object({
    kind: z.object({ type: z.literal('choice'), choice: z.enum(['bugfix', 'feature', 'question', 'unclear']), probabilities: kindProbabilities, confidence: probability }),
    risk: z.object({ type: z.literal('choice'), choice: z.enum(['low', 'medium', 'high', 'unknown']), probabilities: riskProbabilities, confidence: probability }),
    urgency: z.object({ type: z.literal('score'), score: z.number().min(0).max(3), probabilities: scoreProbabilities,
      confidence: probability, legend: z.record(z.string(), z.string()) }),
    testable: z.object({ type: z.literal('noul'), noul: probability })
  }).strict(),
  usage: z.object({ input_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER / 2),
    output_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER / 2) })
});

export function parseJevResult(raw: unknown, model: string): DecisionResult {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.model !== model) throw new DecisionModelError('invalid_response', false);
  const result = parsed.data;
  for (const answer of [result.answers.kind, result.answers.risk, result.answers.urgency]) {
    const probabilities: Record<string, number> = answer.probabilities;
    if (Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.0001)
      throw new DecisionModelError('invalid_response', false);
    if (answer.type === 'choice') {
      const top = Math.max(...Object.values(probabilities)), n = Object.keys(probabilities).length;
      if (Math.abs(probabilities[answer.choice]! - top) > 0.000001
        || Math.abs(answer.confidence - (top - 1 / n) / (1 - 1 / n)) > 0.001)
        throw new DecisionModelError('invalid_response', false);
    }
  }
  const urgency = result.answers.urgency;
  const mean = Object.entries(urgency.probabilities).reduce((sum, [level, value]) => sum + Number(level) * value, 0);
  if (Math.abs(mean - urgency.score) > 0.001 || Object.keys(urgency.legend).length !== urgencyLevels.length
    || urgencyLevels.some((text, index) => urgency.legend[String(index)] !== text))
    throw new DecisionModelError('invalid_response', false);
  return result;
}

async function readResponse(response: Response): Promise<unknown> {
  const limit = 65536;
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body?.cancel(); throw new DecisionModelError('invalid_response', false);
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > limit) { await reader.cancel(); throw new DecisionModelError('invalid_response', false); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new DecisionModelError('invalid_response', false); }
  } finally { reader.releaseLock(); }
}

/** The credential and endpoint belong to the controller, never the Issue or Agent container. */
export class JevClient implements DecisionModel {
  constructor(private config: DecisionConfig, private key: string | undefined, private transport: typeof fetch = fetch) {}
  private request(subject: DecisionSubject) {
    if (!this.key?.trim()) throw new DecisionModelError('missing_key', false);
    const body = JSON.stringify({ model: this.config.model, state: subject, questions: decisionQuestions });
    if (Buffer.byteLength(body) > this.config.maxInputBytes) throw new DecisionModelError('input_too_large', false);
    return body;
  }
  validate(subject: DecisionSubject) { this.request(subject); }
  async evaluate(subject: DecisionSubject, signal?: AbortSignal): Promise<DecisionResult> {
    signal?.throwIfAborted();
    const body = this.request(subject);
    const timeout = AbortSignal.timeout(this.config.timeoutSeconds * 1000);
    try {
      const response = await this.transport('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: `Bearer ${this.key!.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'RepoPilot' }, body
      });
      if (!response.ok) {
        await response.body?.cancel();
        const header = response.headers.get('retry-after'), seconds = header ? Number(header) : 0;
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header ?? '') - Date.now();
        const retryable = response.status === 429 || response.status >= 500;
        throw new DecisionModelError(response.status === 429 ? 'rate_limited' : 'http_error', retryable,
          Number.isFinite(delay) ? Math.max(0, Math.min(31536000000, delay)) : 0);
      }
      return parseJevResult(await readResponse(response), this.config.model);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DecisionModelError) throw error;
      // Provider error bodies and transport exception text may contain request data or credentials.
      throw new DecisionModelError('transport', true);
    }
  }
}
