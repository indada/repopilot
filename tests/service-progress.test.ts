import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHub } from '../src/adapters/github/client.js';
import { flushProgress, queueProgress } from '../src/application/service-progress.js';
import { serviceFixture } from './service-helpers.js';

test('remote comment recovery uses an authenticated-author marker and never edits spoofed feedback', async () => {
  const marker = '<!-- repopilot-progress:' + 'a'.repeat(24) + ' -->', body = marker + '\nVerification completed';
  const comments = [{ id: 1, body, user: { login: 'untrusted' } }];
  let writes = 0, ambiguous = true;
  const client = new GitHub('owner/repo', 'synthetic-token', { transport: async (input, options) => {
    const url = String(input), method = options?.method ?? 'GET';
    if (url === 'https://api.github.com/user') return Response.json({ login: 'maintainer' });
    if (method === 'GET') return Response.json(comments);
    if (method === 'POST') {
      writes++; comments.push({ id: 2, body: JSON.parse(String(options?.body)).body, user: { login: 'maintainer' } });
      if (ambiguous) { ambiguous = false; throw new TypeError('synthetic response loss'); }
      return Response.json({ id: 2 });
    }
    if (method === 'PATCH') { writes++; comments[1]!.body = JSON.parse(String(options?.body)).body; return Response.json({ id: 2 }); }
    assert.fail(method);
  } });
  await assert.rejects(client.syncProgress(7, marker, body));
  assert.equal(await client.syncProgress(7, marker, body), 2); assert.equal(writes, 1);
  await client.syncProgress(7, marker, body + '\nDraft PR ready');
  assert.equal(writes, 2); assert.equal(comments[0]!.body, body);
});
test('progress outbox retries are bounded, resumable and independent from the model circuit', async () => {
  const { d } = await serviceFixture({ service: { progress: true, queue: { maxAttempts: 1 } } });
  await queueProgress(d.services, d.config.repository, 7, 'Awaiting approval');
  let calls = 0;
  const github = { syncProgress: async () => { calls++; throw new Error('synthetic outage'); } };
  const flush = () => flushProgress(d.services, d.config.repository, github, d.config.service!, d.signal, () => {});
  await flush(); await flush(); assert.equal(calls, 1);
  assert.equal((await d.budget.status()).failures, 0);
  await d.services.requestControl(d.config.repository, 'resume'); await flush(); assert.equal(calls, 2);
  await flush(); assert.equal(calls, 2);
  await queueProgress(d.services, d.config.repository, 7, 'Verification completed');
  await flush(); assert.equal(calls, 3);
});

test('delivered and blocked comments do not starve later pending feedback batches', async () => {
  const { d, feedback } = await serviceFixture({ service: { progress: true, queue: { maxBatch: 1 } } });
  await queueProgress(d.services, d.config.repository, 7, 'Done');
  const flush = () => flushProgress(d.services, d.config.repository, d.github, d.config.service!, d.signal, line => assert.fail(line));
  await flush();
  await queueProgress(d.services, d.config.repository, 8, 'Awaiting approval');
  await flush(); assert.ok(feedback.has(8));
  assert.equal((await d.services.progress(d.config.repository)).filter(item => item.digest !== item.deliveredDigest).length, 0);
});
