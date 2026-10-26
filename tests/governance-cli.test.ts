import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Store } from '../src/adapters/storage/file-store.js';
import { main } from '../src/cli/bootstrap.js';
import { governanceFixture } from './governance-helpers.js';

test('CLI exports a pinned suite, replays it offline and applies previewed policy changes under operator control', async () => {
  const { root, config, policy, evaluation, governance } = await governanceFixture();
  const configPath = resolve(root, 'config.json'), suitePath = resolve(root, 'suite.json');
  await writeFile(configPath, JSON.stringify(config)); let lines: string[] = [];
  const output = { write: (value: string) => lines.push(value), error: (value: string) => assert.fail(value) };
  const run = async (...args: string[]) => { lines = []; const code = await main([...args, '--config', configPath], output); return { code, value: JSON.parse(lines.at(-1)!) }; };
  assert.equal((await run('decisions', 'suite', '--suite', 'decision-triage', '--output', suitePath)).code, 0);
  assert.equal(JSON.parse(await readFile(suitePath, 'utf8')).cases.length, 4);
  await assert.rejects(run('decisions', 'suite', '--suite', 'decision-triage', '--output', suitePath), /EEXIST/);
  const replayed = await run('decisions', 'replay', '--spec', suitePath, '--policy', policy.id);
  assert.equal(replayed.code, 0); assert.equal(replayed.value.id, evaluation.id); assert.equal(replayed.value.providerCalls, 0);
  assert.equal((await run('decisions', 'sweep', '--spec', suitePath, '--policy', policy.id)).value.results.length, 9);
  const preview = await run('policies', 'activate', policy.id, '--evaluation', evaluation.id);
  assert.equal(preview.value.eligible, true);
  const release = await new Store(root).acquire();
  try {
    await run('policies', 'activate', policy.id, '--evaluation', evaluation.id, '--apply', '--expected', preview.value.token);
    assert.equal((await governance.requests(config.repository)).length, 1);
    assert.equal((await run('policies', 'status')).value.revision, 0);
    await assert.rejects(run('policies', 'activate', policy.id, '--evaluation', evaluation.id, '--apply', '--expected', 'f'.repeat(24)), /preview/);
  } finally { await release(); }
  assert.equal((await run('decisions', 'process')).value[0].status, 'applied');
  assert.equal((await run('policies', 'status')).value.active, policy.id);
  const rollback = await run('policies', 'rollback');
  await run('policies', 'rollback', '--apply', '--expected', rollback.value.token); await run('decisions', 'process');
  assert.equal((await run('policies', 'status')).value.revision, 2);
  assert.equal((await run('policies', 'status')).value.active, rollback.value.target);
});

test('decision replay and policy commands reject foreign IDs, unknown actions and malformed promotion requests', async () => {
  const { root, config, policy, evaluation } = await governanceFixture(); const configPath = resolve(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...config, repository: 'other/repo' }));
  const output = { write: (_value: string) => {}, error: (_value: string) => {} };
  for (const args of [['policies', 'show', policy.id], ['decisions', 'compare', '--baseline', evaluation.id, '--candidate', evaluation.id],
    ['policies', 'unknown'], ['decisions', 'unknown'], ['policies', 'rollback', policy.id], ['policies', 'activate', '../policy']])
    await assert.rejects(main([...args, '--config', configPath], output));
});
