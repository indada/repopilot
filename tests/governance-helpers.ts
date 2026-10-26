import { FileDecisionGovernanceStore } from '../src/adapters/storage/decision-governance-store.js';
import { evaluateDecisions, exportDecisionSuite } from '../src/application/decision-evaluation.js';
import { decisionEvidenceDigest, policyVersion, type DecisionReview } from '../src/domain/decision-governance.js';
import { configSchema } from '../src/domain/config.js';
import { taskId } from '../src/domain/identity.js';
import { decisionFixture, decisionResult, decisionSubject } from './decision-helpers.js';

export async function governanceFixture() {
  const fixture = await decisionFixture();
  const governance = new FileDecisionGovernanceStore(fixture.root);
  const config = configSchema.parse({ repository: 'owner/repo', dataDir: fixture.root,
    decision: { enabled: true, useManagedPolicy: true, mode: 'gate' } });
  for (let index = 0; index < 4; index++) {
    const subject = { ...decisionSubject, issue: index + 1, candidateId: taskId(['candidate', index]) };
    await fixture.evaluator.evaluate(subject, new AbortController().signal);
  }
  const records = await fixture.store.list('owner/repo');
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    record.result = decisionResult({ risk: index % 2 ? 'high' : 'low' });
    await fixture.store.save(record);
    const review: DecisionReview = { schemaVersion: 1, id: taskId(['review', record.id]), repository: 'owner/repo',
      decisionId: record.id, inputDigest: record.inputDigest, evidenceDigest: decisionEvidenceDigest(record),
      labels: { expectedRoute: index % 2 ? 'review' : 'continue', expectedKind: 'bugfix', expectedRisk: index % 2 ? 'high' : 'low',
        testable: true, reviewer: 'local-operator', note: 'Human-reviewed fixed fixture.' }, createdAt: '2026-10-26T00:00:00Z', requestId: taskId(['request', record.id]) };
    await governance.saveReview(review);
  }
  const policy = policyVersion('owner/repo', { name: 'conservative', model: 'jev-1.13.0', mode: 'gate' });
  await governance.savePolicy(policy);
  const suite = await exportDecisionSuite('owner/repo', 'decision-triage', fixture.store, governance);
  const evaluation = await evaluateDecisions(suite, 'owner/repo', config.decision!, policy, fixture.store, governance);
  await governance.saveEvaluation(evaluation);
  return { ...fixture, config, governance, suite, policy, evaluation, records: await fixture.store.list('owner/repo') };
}
