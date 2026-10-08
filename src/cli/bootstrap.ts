import { DockerCodexAgent } from '../adapters/codex/docker-agent.js';
import { CodexAgentTeam } from '../adapters/codex/team.js';
import { GitHub } from '../adapters/github/client.js';
import { Store } from '../adapters/storage/file-store.js';
import { FileIterationStore } from '../adapters/storage/iteration-store.js';
import { FileCandidateStore } from '../adapters/storage/candidate-store.js';
import { FileServiceStore } from '../adapters/storage/service-store.js';
import { startWebhookServer } from '../adapters/github/webhook-server.js';
import { gitRepository } from '../adapters/storage/repository.js';
import { DockerRunner } from '../adapters/testing/docker-runner.js';
import { DockerRecoveryResources } from '../adapters/testing/recovery-resources.js';
import { ControllerLock } from '../adapters/storage/controller-lock.js';
import { applyRecovery, recoveryPreview } from '../application/recovery.js';
import { fixIssue } from '../application/issue.js';
import { runService, validateService } from '../application/service.js';
import { ServiceBudget } from '../application/service-budget.js';
import { describeTestEnvironment } from '../domain/runner-config.js';
import { VERSION } from '../shared/version.js';
import { help, parseCli } from './args.js';
import { check } from './commands/check.js';
import { inspectTasks, runTask } from './commands/tasks.js';
import { watchCommand } from './commands/watch.js';
import { doctor, initialize } from './commands/setup.js';
import { executeGoals, inspectGoals, validateGoalCommand } from './commands/goals.js';
import { executeCandidates, inspectCandidates, validateCandidateCommand } from './commands/candidates.js';
import { inspectService } from './commands/service.js';
import { loadConfig } from './config.js';
import { reportExitCode, reportSummary } from './output.js';
import type { Output, Runtime } from './runtime.js';
const standardOutput: Output = { write: value => console.log(value), error: value => console.error(value) };
export async function main(args: string[], output: Output = standardOutput): Promise<number> {
  const { positionals, values } = parseCli(args);
  const command = positionals[0];
  if (values.version) { output.write(VERSION); return 0; }
  if (values.help || !command) { output.write(help); return 0; }
  if (command === 'init') return initialize(values, output);
  if (command === 'doctor') return doctor(values, output);
  if (!values.config || !['check', 'watch', 'tasks', 'recover', 'fix', 'goals', 'iterate', 'discover', 'experiences', 'evals', 'candidates', 'serve', 'service', 'events'].includes(command)) throw new Error('Use a repository command with --config; see --help.');
  const config = await loadConfig(values.config), store = new Store(config.dataDir);
  if (command === 'recover') {
    const lock = new ControllerLock(config.dataDir), resources = new DockerRecoveryResources(config.dataDir);
    if (values.apply && !values.expected) throw new Error('Apply requires --expected PREVIEW_TOKEN from recover.');
    if (values.apply) {
      const result = await applyRecovery(config.repository, values.expected!, store, lock, resources);
      output.write(JSON.stringify(result, null, 2)); return result.errors.length ? 1 : 0;
    }
    output.write(JSON.stringify(await recoveryPreview(config.repository, store, lock, resources), null, 2)); return 0;
  }
  const action = positionals[1], task = positionals[2];
  validateGoalCommand(command, action, task, values);
  if (command === 'candidates') validateCandidateCommand(action, task, values);
  const goals = new FileIterationStore(config.dataDir), candidates = new FileCandidateStore(config.dataDir);
  const services = new FileServiceStore(config.dataDir);
  if (await inspectService(command, action, task, values, config, services, candidates, output)) return 0;
  if (command === 'serve') validateService(config);
  const inspection = await inspectGoals(command, action, task, values, config, goals, output);
  if (inspection) return inspection === 'ineligible' ? 1 : 0;
  if (command === 'candidates' && await inspectCandidates(action, task, values, config, candidates, output)) return 0;
  if (command === 'tasks' && await inspectTasks(action, task, values, config, store, output)) return 0;
  const release = await store.acquire();
  const abort = new AbortController(), stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const budget = config.service ? new ServiceBudget(services, config.repository, config.service,
      config.agent.enabled ? config.agent.maxTokens : 0) : undefined;
    const github = new GitHub(config.repository, undefined, { signal: abort.signal, retry: config.retry });
    const runtime: Runtime = { config, store, repository: gitRepository, signal: abort.signal,
      onTaskStart: budget ? () => budget.startTask() : undefined,
      runner: config.runner ? new DockerRunner(config.runner, config.dataDir) : undefined,
      agent: config.agent.enabled ? (config.iteration?.collaboration
        ? new CodexAgentTeam(config.agent, config.iteration.collaboration, config.dataDir,
          config.runner ? describeTestEnvironment(config.runner) : undefined, budget)
        : new DockerCodexAgent(config.agent, config.dataDir,
          config.runner ? describeTestEnvironment(config.runner) : undefined, undefined, undefined, budget)) : undefined,
      github };
    const automation = {
      ...runtime, goals, github, candidates,
      onAdvance: budget ? () => budget.startTask() : undefined,
      previewRunner: config.iteration?.preview ? new DockerRunner(config.iteration.preview, config.dataDir) : undefined
    };
    if (command === 'serve') {
      const webhook = config.service?.webhook && !values.once ? await startWebhookServer(config.repository,
        config.service.webhook, process.env[config.service.webhook.secretEnv] ?? '', event => services.enqueue(event, config.service!.queue.maxPending)) : undefined;
      if (webhook) output.write(JSON.stringify({ webhook: webhook.address }));
      try { return await runService({ ...automation, services, budget: budget! }, !!values.once,
        value => output.write(JSON.stringify(value)), value => output.error(value)); }
      finally { await webhook?.close(); }
    }
    if (budget && (command === 'check' || command === 'fix'
      || command === 'goals' && ['plan', 'run', 'replan'].includes(action ?? '')
      || command === 'candidates' && ['reproduce', 'run'].includes(action ?? '')
      || command === 'tasks' && ['resume', 'rerun'].includes(action ?? '') || command === 'evals' && action === 'replay'))
      await budget.startTask();
    if (command === 'candidates') return executeCandidates(action!, task, values, { ...automation, candidates }, output);
    if (['goals', 'iterate', 'discover', 'evals'].includes(command)) return executeGoals(command, action, task, values, automation, output);
    if (command === 'watch') { await watchCommand(values, runtime, output); return 0; }
    if (command === 'fix') {
      const report = await fixIssue(Number(values.issue), values.branch, { ...runtime, github });
      output.write(reportSummary(report, config)); return reportExitCode(report);
    }
    const report = command === 'check' ? await check(values, runtime) : await runTask(action!, task!, runtime);
    output.write(reportSummary(report, config)); return reportExitCode(report);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await release(); }
}
