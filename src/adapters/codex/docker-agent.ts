import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Answer } from '../../domain/agent-answer.js';
import type { AgentRole } from '../../domain/collaboration.js';
import { answerSchema } from '../../domain/agent-answer.js';
import type { Config } from '../../domain/config.js';
import type { describeTestEnvironment } from '../../domain/runner-config.js';
import type { Snapshot } from '../../domain/types.js';
import { changedPaths } from '../../domain/snapshot.js';
import { isTest } from '../../domain/repair.js';
import type { Agent } from '../../ports/agent.js';
import type { ModelCallBudget } from '../../ports/service.js';
import { RetryableError, throwIfAborted } from '../../shared/control.js';
import { execute } from '../../shared/process.js';
import { ownerLabels, resourceOwner } from '../../shared/resource-owner.js';
import { contextBatches } from './context.js';

export class SharedAgentBudget {
  private calls = 0;
  private tokens = 0;
  private unaccounted = 0;
  constructor(private maxCalls: number, private maxTokens: number) {}
  reset() { this.calls = 0; this.tokens = 0; this.unaccounted = 0; }
  usage() { return { calls: this.calls, tokens: this.tokens, complete: this.unaccounted === 0 }; }
  reserveCall() {
    if (this.calls >= this.maxCalls || this.tokens >= this.maxTokens) throw new Error('Agent task budget exhausted.');
    this.calls++;
  }
  beginUnaccounted() { this.unaccounted++; }
  settle(tokens: number) {
    this.tokens += tokens; this.unaccounted--;
    if (this.tokens > this.maxTokens) throw new Error('Agent task token budget exceeded; further calls blocked.');
  }
}

export class DockerCodexAgent implements Agent {
  private budget: SharedAgentBudget;
  constructor(private config: Config['agent'], private dataDir: string,
    private testEnvironment?: ReturnType<typeof describeTestEnvironment>, budget?: SharedAgentBudget,
    private assignedRole?: AgentRole, private globalBudget?: ModelCallBudget) {
    this.budget = budget ?? new SharedAgentBudget(config.maxCalls, config.maxTokens);
  }
  resetBudget() { this.budget.reset(); }
  usage() { return this.budget.usage(); }
  forkExecution(): Agent { return new DockerCodexAgent(this.config, this.dataDir, this.testEnvironment, undefined, this.assignedRole, this.globalBudget); }
  design(base: Snapshot, context: string, signal?: AbortSignal) { return this.call('roadmap', base, base, context, signal); }
  review(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal, paths?: string[]) { return this.call('review', base, head, description, signal, paths); }
  plan(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal, intent?: 'feature' | 'bugfix') { return this.call('plan', base, head, description, signal, undefined, intent); }
  repair(base: Snapshot, head: Snapshot, evidence: string, signal?: AbortSignal, intent?: 'feature' | 'bugfix') { return this.call('repair', base, head, evidence, signal, undefined, intent); }
  private async call(mode: string, base: Snapshot, head: Snapshot, context: string, signal?: AbortSignal, paths?: string[], intent?: 'feature' | 'bugfix'): Promise<Answer> {
    if (!process.env.OPENAI_API_KEY) throw new Error('Agent container requires OPENAI_API_KEY.');
    const diff = changedPaths(base, head);
    const selected = paths ?? (!diff.length || (mode === 'repair' && diff.every(isTest)) ? [...head.keys()] : undefined);
    const batches = contextBatches(base, head, selected);
    const combined: Answer = { findings: [], changes: [], scenarios: [], summary: '' };
    for (const batch of batches) {
      throwIfAborted(signal);
      this.budget.reserveCall();
      const role = this.assignedRole ?? ({ roadmap: 'planner', plan: 'tester', repair: 'developer', review: 'reviewer' } as const)[mode as 'roadmap' | 'plan' | 'repair' | 'review'];
      const input = JSON.stringify({ mode, role, intent, model: this.config.model, context, testEnvironment: this.testEnvironment, ...batch });
      if (Buffer.byteLength(input) > 500000) throw new Error('Evidence/context exceeds per-call budget.');
      const name = 'repopilot-agent-' + randomUUID(), root = resolve(this.dataDir, 'work', name);
      await mkdir(root, { recursive: true }); await writeFile(resolve(root, 'input.json'), input);
      const reservation = await this.globalBudget?.reserve();
      let tokens: number | undefined;
      try {
        this.budget.beginUnaccounted();
        const result = await execute('docker', ['run', '--rm', '--name', name, '--read-only',
          ...ownerLabels(await resourceOwner(this.dataDir)),
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '2g', '--cpus', '2',
          '--user', '65534:65534', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
          '--mount', `type=bind,source=${root},target=/input,readonly`,
          '-e', 'OPENAI_API_KEY', '-e', 'CODEX_HOME=/tmp/codex', '-e', 'HOME=/tmp', this.config.image],
          { timeoutMs: this.config.timeoutSeconds * 1000, signal });
        if (result.code === 125 || result.timedOut) throw new RetryableError('Codex container was unavailable or timed out.');
        if (result.code !== 0) throw new Error('Codex container failed: ' + result.stderr.slice(-2000));
        const envelope = z.object({ answer: answerSchema, tokens: z.number().int().nonnegative() }).parse(JSON.parse(result.stdout));
        tokens = envelope.tokens;
        this.budget.settle(envelope.tokens);
        for (const change of envelope.answer.changes) {
          if (mode === 'repair' && head.has(change.path) && !batch.diff.some(f => f.path === change.path) && !batch.files.some(f => f.path === change.path)) {
            throw new Error('Repair targets a file outside supplied context: ' + change.path);
          }
          const previous = combined.changes.find(c => c.path === change.path);
          if (previous && previous.content !== change.content) throw new Error('Conflicting edits across context batches: ' + change.path);
          if (!previous) combined.changes.push(change);
        }
        combined.findings.push(...envelope.answer.findings); combined.scenarios.push(...envelope.answer.scenarios);
        if (envelope.answer.steps?.length) {
          if (combined.steps && JSON.stringify(combined.steps) !== JSON.stringify(envelope.answer.steps)) throw new Error('Conflicting task plans across context batches.');
          combined.steps = envelope.answer.steps;
        }
        combined.summary += envelope.answer.summary + '\n';
      } finally {
        try { await reservation?.settle(tokens); }
        finally { await execute('docker', ['rm', '-f', name], { timeoutMs: 10000 }).catch(() => undefined); }
      }
    }
    return combined;
  }
}
