import { readFile, writeFile } from 'node:fs/promises';
import { configSchema } from '../../domain/config.js';
import { testCommands } from '../../domain/runner-config.js';
import { execute } from '../../shared/process.js';
import { VERSION } from '../../shared/version.js';
import type { CliValues } from '../args.js';
import { loadConfig } from '../config.js';
import type { Output } from '../runtime.js';

export async function initialize(values: CliValues, output: Output): Promise<number> {
  if (!values.repo) throw new Error('Use init --repo OWNER/REPOSITORY [--config config.local.json].');
  const config = configSchema.parse({ repository: values.repo, runner: { command: ['node', '--test'] },
    agent: { image: 'ghcr.io/indada/repopilot-agent:' + VERSION } });
  const path = values.config ?? 'config.local.json';
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  output.write('Created ' + path + '. Review test commands; enable agent/repair/publish when ready.');
  return 0;
}

export async function doctor(values: CliValues, output: Output, run = execute): Promise<number> {
  if (!values.config) throw new Error('Use doctor --config config.local.json.');
  const config = await loadConfig(values.config);
  let failed = false;
  const check = (name: string, success: boolean) => {
    output.write((success ? 'OK ' : 'FAIL ') + name); failed ||= !success;
  };
  check('configuration', true);
  const probe = async (name: string, binary: string, args: string[], expected?: string) => {
    try { const result = await run(binary, args, { timeoutMs: 15000 }); check(name, result.code === 0 && !result.timedOut && (!expected || result.stdout.trim() === expected)); }
    catch { check(name, false); }
  };
  await probe('Git', 'git', ['--version']);
  if (config.runner || config.agent.enabled) {
    await probe('Docker daemon (Linux containers)', 'docker', ['info', '--format', '{{.OSType}}'], 'linux');
    const images = new Set<string>();
    if (config.runner) {
      for (const command of testCommands(config.runner)) images.add(command.image ?? config.runner.image);
      for (const service of config.runner.services ?? []) images.add(service.image);
    }
    if (config.agent.enabled) images.add(config.agent.image);
    for (const image of images) await probe('image ' + image, 'docker', ['image', 'inspect', image]);
    if (config.runner && testCommands(config.runner).some(c => c.reporter === 'node')) {
      try { await readFile(new URL('../../../dist/adapters/testing/node-reporter.js', import.meta.url)); check('Node reporter', true); }
      catch { check('Node reporter (build required)', false); }
    }
  }
  if (config.agent.enabled) check('OPENAI_API_KEY is set (not authenticated)', !!process.env.OPENAI_API_KEY);
  if (config.decision?.enabled) check(config.decision.apiKeyEnv + ' is set for Jev (not authenticated)', !!process.env[config.decision.apiKeyEnv]);
  output.write('GitHub token present (not authenticated): ' + !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN));
  if (config.publish) check('GitHub token required for publishing', !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN));
  output.write('Read-only checks completed; no containers started and no model calls made.');
  return failed ? 1 : 0;
}
