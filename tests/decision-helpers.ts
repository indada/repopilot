import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileDecisionStore } from '../src/adapters/storage/decision-store.js';
import { CandidateDecisionEvaluator } from '../src/application/decisions.js';
import { decisionSchema, type DecisionResult, type DecisionSubject } from '../src/domain/decision.js';
import { urgencyLevels } from '../src/domain/decision-policy.js';
import type { DecisionModel } from '../src/ports/decision.js';

export function decisionResult(options: { kind?: DecisionResult['answers']['kind']['choice']; risk?: DecisionResult['answers']['risk']['choice']; testable?: number } = {}): DecisionResult {
  const kind = options.kind ?? 'bugfix', risk = options.risk ?? 'low';
  return { model: 'jev-1.13.0', answers: {
    kind: { type: 'choice', choice: kind, probabilities: { bugfix: 0.01, feature: 0.01, question: 0.01, unclear: 0.01, [kind]: 0.97 }, confidence: 0.96 },
    risk: { type: 'choice', choice: risk, probabilities: { low: 0.01, medium: 0.01, high: 0.01, unknown: 0.01, [risk]: 0.97 }, confidence: 0.96 },
    urgency: { type: 'score', score: 1, confidence: 1, legend: Object.fromEntries(urgencyLevels.map((text, index) => [String(index), text])),
      probabilities: { '0': 0, '1': 1, '2': 0, '3': 0 } }, testable: { type: 'noul', noul: options.testable ?? 0.98 }
  }, usage: { input_tokens: 100, output_tokens: 20 } };
}
export const decisionSubject: DecisionSubject = { repository: 'owner/repo', candidateId: 'a'.repeat(24), evidenceDigest: 'b'.repeat(24),
  issue: 7, commit: 'c'.repeat(40), branch: 'main', title: 'Reject negative quantities',
  request: 'Reject negative quantities with a validation error.', intent: 'bugfix', allowedPaths: ['src', 'test'] };
export async function decisionFixture(raw: Record<string, unknown> = {}, model?: DecisionModel, clock?: () => number) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/decisions-')), store = new FileDecisionStore(root);
  const config = decisionSchema.parse({ enabled: true, ...raw }); let calls = 0;
  const provider: DecisionModel = model ?? { evaluate: async () => { calls++; return decisionResult(); } };
  const evaluator = new CandidateDecisionEvaluator('owner/repo', config, store, provider, clock);
  return { root, store, config, evaluator, calls: () => calls };
}
