import { resolve } from 'node:path';
import type { Config } from '../domain/config.js';
import { descriptionHash, pipelineId } from '../domain/identity.js';
import type { Report } from '../domain/types.js';
import type { Agent } from '../ports/agent.js';
import type { GitHub } from '../ports/github.js';
import type { Repository } from '../ports/repository.js';
import type { Runner } from '../ports/runner.js';
import type { Store } from '../ports/store.js';
import { pause, withFreshness } from '../shared/control.js';
import { runPipeline } from './pipeline.js';
import { finishReport } from './publication.js';

export interface WatchDependencies {
  config: Config; store: Store; agent?: Agent; runner?: Runner;
  github: GitHub; repository: Repository; signal: AbortSignal;
  onTaskStart?: () => Promise<void>;
}
export async function reviewPull(number: number, deps: WatchDependencies): Promise<Report | undefined> {
  const { config, store, agent, runner, github, repository, signal } = deps;
  const pr = await github.pull(number);
  if (pr.state !== 'open' || pr.draft || pr.head.ref.startsWith('autofix/')
    || pr.head.repo?.full_name !== config.repository || pr.base.repo.full_name !== config.repository) return;
  const cache = resolve(config.dataDir, 'git-cache'); await repository.prepare(cache);
  const previous = await store.read(pipelineId({ baseSha: pr.base.sha, headSha: pr.head.sha, pr }, config));
  if (!previous || ['running', 'cancelled'].includes(previous.status) && previous.executions < config.retry.maxTaskExecutions
    || previous.status === 'error' && previous.retryable && previous.executions < config.retry.maxTaskExecutions
      && Date.parse(previous.retryAfter ?? '') <= Date.now())
    await deps.onTaskStart?.();
  const report = await withFreshness(async controlled => {
    await repository.fetch(cache, config.repository, pr.base.sha, pr.head.sha, controlled);
    return runPipeline({ base: await repository.snapshot(cache, pr.base.sha, controlled),
      head: await repository.snapshot(cache, pr.head.sha, controlled),
      baseSha: pr.base.sha, headSha: pr.head.sha, repoPath: cache, pr, description: pr.title + '\n' + (pr.body ?? '') },
      config, store, runner, agent, controlled);
  }, async () => {
    const latest = await github.pull(pr.number);
    return latest.state === 'open' && !latest.draft && latest.head.repo?.full_name === config.repository
      && latest.base.repo.full_name === config.repository && latest.head.sha === pr.head.sha
      && latest.base.sha === pr.base.sha && descriptionHash(latest) === descriptionHash(pr);
  }, config.freshnessSeconds * 1000, signal);
  await finishReport(report, config, store, github, signal); return report;
}
export async function watch(deps: WatchDependencies, once: boolean,
  onReport: (report: Report) => void, onError: (message: string) => void): Promise<void> {
  const { config, github, signal } = deps;
  do {
    const pulls = await github.listPulls();
    for (const summary of pulls) {
      if (signal.aborted) break;
      if (summary.draft || summary.head.repo?.full_name !== config.repository || summary.head.ref.startsWith('autofix/')) continue;
      try {
        const report = await reviewPull(summary.number, deps); if (report) onReport(report);
      } catch (error) { onError('PR #' + summary.number + ': ' + String(error)); }
    }
    if (!once && !signal.aborted) await pause(config.pollSeconds * 1000, signal).catch(() => undefined);
  } while (!once && !signal.aborted);
}
