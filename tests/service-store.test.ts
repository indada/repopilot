import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { FileServiceStore } from '../src/adapters/storage/service-store.js';
import { pollEvent } from '../src/domain/service-events.js';

async function fixture() {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/events-'));
  return { root, data: new FileServiceStore(root) };
}
test('atomic delivery append deduplicates concurrent processes without exposing partial JSON', async () => {
  const { root, data } = await fixture(), other = new FileServiceStore(root);
  const event = pollEvent('owner/repo', 'delivery-1', 'issue', 7);
  const results = await Promise.all([data.enqueue(event, 10), other.enqueue(event, 10)]);
  assert.deepEqual(results.sort(), ['created', 'duplicate']);
  assert.equal((await data.events('owner/repo')).length, 1);
  await assert.rejects(data.enqueue({ ...event, digest: 'different' }, 10), /different evidence/);
  assert.deepEqual(await data.events('other/repo'), []);
});
test('queue capacity, receipt recovery and retention preserve all unfinished evidence', async () => {
  const { root, data } = await fixture();
  const a = pollEvent('owner/repo', 'delivery-1', 'issue', 7), b = pollEvent('owner/repo', 'delivery-2', 'pull', 8);
  await data.enqueue(a, 1);
  await assert.rejects(data.enqueue(b, 1), /full/);
  await data.receipt(a.id, { status: 'processing', attempts: 1, updatedAt: '2020-01-01T00:00:00Z' });
  assert.equal((await new FileServiceStore(root).events('owner/repo'))[0]?.receipt?.status, 'processing');
  assert.equal(await data.prune('owner/repo', '2026-01-01'), 0);
  await data.receipt(a.id, { status: 'dead', attempts: 3, updatedAt: '2020-01-01T00:00:00Z' });
  await data.enqueue(b, 1);
  assert.equal(await data.prune('owner/repo', '2026-01-01'), 0);
  await data.receipt(a.id, { status: 'completed', attempts: 3, updatedAt: '2020-01-01T00:00:00Z' });
  assert.equal(await data.prune('owner/repo', '2026-01-01'), 1);
  assert.equal((await data.events('owner/repo'))[0]?.event.id, b.id);
});
