import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { startWebhookServer, validWebhookSignature } from '../src/adapters/github/webhook-server.js';
import { FileServiceStore } from '../src/adapters/storage/service-store.js';
import { serviceSchema } from '../src/domain/service.js';

const secret = 'synthetic-webhook-secret-for-local-tests';
test('webhook signature validation matches the GitHub vector and rejects malformed or tampered bytes', () => {
  assert.ok(validWebhookSignature(Buffer.from('Hello, World!'),
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17', "It's a Secret to Everybody"));
  assert.equal(validWebhookSignature(Buffer.from('tampered'), 'sha256=' + '0'.repeat(64), secret), false);
  assert.equal(validWebhookSignature(Buffer.from('{}'), 'sha256=abc', secret), false);
  assert.equal(validWebhookSignature(Buffer.from('{}'), undefined, secret), false);
});
test('HTTP ingress acknowledges only persisted signed repository hints and enforces limits', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const data = new FileServiceStore(await mkdtemp(resolve('.cache/tests/webhook-')));
  const config = { ...serviceSchema.parse({ webhook: { maxBodyBytes: 1024 } }).webhook!, port: 0 };
  const server = await startWebhookServer('owner/repo', config, secret, event => data.enqueue(event, 10));
  const address = server.address; assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}${config.path}`;
  const send = (body: string, delivery: string, options: { signature?: string; event?: string } = {}) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Delivery': delivery, 'X-GitHub-Event': options.event ?? 'issues',
      'X-Hub-Signature-256': options.signature ?? 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') }, body });
  try {
    const body = JSON.stringify({ repository: { full_name: 'owner/repo' }, action: 'opened', issue: { number: 7, title: 'Untrusted payload text' } });
    assert.equal((await send(body, 'first')).status, 202);
    const event = (await data.events('owner/repo'))[0]!.event;
    assert.equal(event.number, 7); assert.ok(!JSON.stringify(event).includes('Untrusted payload text'));
    assert.equal((await send(body, 'first')).status, 202);
    assert.equal((await data.events('owner/repo')).length, 1);
    assert.equal((await send(body, 'bad-signature', { signature: 'sha256=' + '0'.repeat(64) })).status, 403);
    assert.equal((await send(body.replace('owner/repo', 'other/repo'), 'foreign')).status, 400);
    assert.equal((await send('{malformed', 'invalid')).status, 400);
    assert.equal((await send(body, 'ping', { event: 'ping' })).status, 200);
    assert.equal((await send('x'.repeat(2048), 'oversized')).status, 413);
    assert.equal((await data.events('owner/repo')).length, 1);
    assert.equal((await fetch(url, { method: 'GET' })).status, 405);
  } finally { await server.close(); }
});
test('ingress returns a retryable failure when durable storage is unavailable', async () => {
  const config = { ...serviceSchema.parse({ webhook: {} }).webhook!, port: 0 };
  const server = await startWebhookServer('owner/repo', config, secret, async () => { throw new Error('synthetic disk outage'); });
  const address = server.address; assert.ok(address && typeof address !== 'string');
  try {
    const body = JSON.stringify({ repository: { full_name: 'owner/repo' }, action: 'opened', issue: { number: 7 } });
    const response = await fetch(`http://127.0.0.1:${address.port}${config.path}`, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Delivery': 'disk-failure', 'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } });
    assert.equal(response.status, 503);
  } finally { await server.close(); }
});
