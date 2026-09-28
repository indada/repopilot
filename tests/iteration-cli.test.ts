import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { main } from '../src/cli/bootstrap.js';
import { parseCli } from '../src/cli/args.js';
import { executeGoals } from '../src/cli/commands/goals.js';
import { configSchema } from '../src/domain/config.js';
import type { AutomationDependencies } from '../src/application/automation.js';
import { FileIterationStore } from '../src/adapters/storage/iteration-store.js';
import { FileCandidateStore } from '../src/adapters/storage/candidate-store.js';
import { candidateFromSignal } from '../src/domain/candidate.js';
import { Store } from '../src/adapters/storage/file-store.js';
import type { GoalState } from '../src/domain/iteration.js';

test('goal inspection and pause work under a controller lock and enforce repository isolation', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/iteration-cli-')), config = resolve(root, 'config.json');
  await writeFile(config, JSON.stringify({ repository: 'owner/repo', dataDir: root }));
  const goals = new FileIterationStore(root), id = 'a'.repeat(24);
  const state: GoalState = { schemaVersion: 1, id, repository: 'owner/repo', configHash: 'old-config',
    spec: { title: 'Example goal', objective: 'Implement a feature', mode: 'feature', acceptance: [{ id: 'accept', text: 'Expected behavior' }], allowedPaths: ['src'],
      evaluation: { suite: 'core-suite', case: 'example-case', profile: 'codex-default' } },
    branch: 'main', sha: 'a'.repeat(40), status: 'planned', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    steps: [], completed: [], changes: [], reports: [], rounds: 0, calls: 0, tokens: 0, elapsedMs: 0, notes: [] };
  await goals.save(state); await goals.save({ ...state, id: 'b'.repeat(24), repository: 'other/repo' });
  const candidates = new FileCandidateStore(root), candidate = candidateFromSignal({
    kind: 'issue', repository: 'owner/repo', identity: [7], evidence: ['issue'], commit: 'a'.repeat(40),
    branch: 'main', issue: 7, title: 'Reject negative quantities', detail: 'Negative quantities must fail.',
    priority: 70, priorityReasons: ['trusted'] });
  await candidates.save(candidate);
  await goals.remember({ id, goalId: id, repository: state.repository, sha: state.sha, configHash: state.configHash,
    outcome: state.status, completed: [], reportIds: [], notes: [], createdAt: state.createdAt });
  const lines: string[] = [], output = { write: (line: string) => lines.push(line), error: (_line: string) => {} };
  const release = await new Store(root).acquire();
  try {
    assert.equal(await main(['goals', 'list', '--config', config], output), 0);
    assert.equal(JSON.parse(lines.at(-1)!).total, 1);
    assert.equal(await main(['goals', 'show', id, '--config', config], output), 0);
    assert.equal(JSON.parse(lines.at(-1)!).configHash, 'old-config');
    assert.equal(await main(['goals', 'graph', id, '--config', config], output), 0);
    assert.deepEqual(JSON.parse(lines.at(-1)!).steps, []);
    assert.deepEqual(JSON.parse(lines.at(-1)!).waveHistory, []);
    assert.deepEqual(JSON.parse(lines.at(-1)!).serialReplay, []);
    assert.equal(await main(['goals', 'pause', id, '--config', config], output), 0);
    assert.equal(await goals.paused(id), true);
    assert.equal((await goals.read(id))!.status, 'planned');
    await assert.rejects(main(['goals', 'pause', 'b'.repeat(24), '--config', config], output), /this repository/);
    assert.equal(await goals.paused('b'.repeat(24)), false);
    assert.equal(await main(['experiences', '--config', config], output), 0);
    assert.equal(JSON.parse(lines.at(-1)!).experiences[0].goalId, id);
    assert.equal(await main(['evals', '--suite', 'core-suite', '--config', config], output), 0);
    assert.equal(JSON.parse(lines.at(-1)!).records[0].case, 'example-case');
    assert.equal(await main(['evals', 'gate', '--suite', 'core-suite', '--baseline', 'baseline',
      '--candidate', 'codex-default', '--config', config], output), 1);
    assert.equal(JSON.parse(lines.at(-1)!).eligible, false);
    assert.equal(await main(['candidates', 'list', '--config', config], output), 0);
    assert.equal(JSON.parse(lines.at(-1)!).candidates[0].id, candidate.id);
    assert.equal(await main(['candidates', 'show', candidate.id, '--config', config], output), 0);
    assert.equal(JSON.parse(lines.at(-1)!).evidenceDigest, candidate.evidenceDigest);
    await assert.rejects(main(['candidates', 'approve', candidate.id, '--config', config], output), /--expected/);
    await assert.rejects(main(['candidates', 'show', 'b'.repeat(24), '--config', config], output), /this repository/);
    await assert.rejects(main(['goals', 'list', '--limit', '0', '--config', config], output), /pagination/);
    await assert.rejects(main(['goals', 'list', '--status', 'unknown', '--config', config], output), /status/);
    await assert.rejects(main(['goals', 'plan', '--config', config], output), /--spec/);
    await assert.rejects(main(['goals', 'run', '--config', config], output), /ID is required/);
    await assert.rejects(main(['discover', '--apply', '--config', config], output), /--expected/);
    await assert.rejects(main(['discover', '--expected', 'token', '--config', config], output), /--apply/);
  } finally { await release(); }
});

test('goal specification and queue flags are parsed without ambiguity', () => {
  const result = parseCli(['goals', 'plan', '--spec', 'goal.json', '--config', 'local.json']);
  assert.equal(result.values.spec, 'goal.json'); assert.deepEqual(result.positionals, ['goals', 'plan']);
  assert.equal(parseCli(['iterate', '--once']).values.once, true);
  assert.deepEqual(parseCli(['goals', 'graph', 'a'.repeat(24)]).positionals, ['goals', 'graph', 'a'.repeat(24)]);
  assert.equal(parseCli(['evals', 'replay', '--profile', 'new-strategy']).values.profile, 'new-strategy');
});

test('iteration polling exits on cancellation and refuses an unconfigured loop', async () => {
  const abort = new AbortController(), output = { write: (_line: string) => {}, error: (_line: string) => {} };
  // No adapter may be touched before validating the polling configuration or cancellation.
  const deps = { signal: abort.signal, config: configSchema.parse({ repository: 'owner/repo' }) } as AutomationDependencies;
  await assert.rejects(executeGoals('iterate', undefined, undefined, { once: true }, deps, output), /iteration.queue or iteration.maintenance/);
  abort.abort();
  assert.equal(await executeGoals('iterate', undefined, undefined, {}, deps, output), 0);
});

test('automatic Issue intake stops when the configured strategy lacks replay evidence', async () => {
  const output = { write: (_line: string) => {}, error: (_line: string) => {} };
  const config = configSchema.parse({ repository: 'owner/repo', iteration: {
    queue: { labels: ['agent-ready'], trustedAuthors: ['maintainer'], allowedPaths: ['src'] },
    strategyGate: { suite: 'core-suite', baselineProfile: 'baseline', candidateProfile: 'candidate' }
  } });
  const deps = { signal: new AbortController().signal, config, goals: { list: async () => [] },
    github: { issues: async () => assert.fail('Gate must run before Issue intake') } } as unknown as AutomationDependencies;
  await assert.rejects(executeGoals('iterate', undefined, undefined, { once: true }, deps, output), /Strategy gate blocked/);
});
