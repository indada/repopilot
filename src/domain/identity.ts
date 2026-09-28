import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { RunInput } from './task.js';
import type { PullRequest } from './types.js';

export function taskId(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24); }
export function descriptionHash(pr?: PullRequest, description = ''): string {
  return taskId(pr ? [pr.title, pr.body ?? ''] : description);
}
export function pipelineId(input: Pick<RunInput, 'pr' | 'issue' | 'description' | 'baseSha' | 'headSha' | 'runKey' | 'implementation' | 'reproductionOnly'>, config: Config): string {
  return taskId({ version: 3, repository: config.repository, pr: input.pr?.number, base: input.baseSha, head: input.headSha,
    description: descriptionHash(input.pr, input.description), config, runKey: input.runKey, issue: input.issue,
    implementation: input.implementation, reproductionOnly: input.reproductionOnly });
}
