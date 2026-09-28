import { z } from 'zod';
import { goalSpecSchema } from './iteration.js';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const evaluationSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  suite: id,
  cases: z.array(z.object({
    id,
    branch: z.string().min(1).max(200),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    spec: goalSpecSchema.refine(spec => !spec.branch && !spec.issue && !spec.evaluation,
      'Evaluation cases must use pinned local specs without Issue, branch or evaluation overrides.')
  }).strict()).min(1).max(100)
}).strict().refine(value => new Set(value.cases.map(item => item.id)).size === value.cases.length,
  'Evaluation case IDs must be unique.');
export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;
