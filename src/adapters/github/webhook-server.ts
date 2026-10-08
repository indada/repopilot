import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { taskId } from '../../domain/identity.js';
import type { ServiceConfig, ServiceEvent } from '../../domain/service.js';
import { webhookTarget } from '../../domain/service-events.js';

export function validWebhookSignature(body: Uint8Array, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(body).digest(), Buffer.from(signature.slice(7), 'hex'));
}
class RequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function header(request: IncomingMessage, name: string) {
  const value = request.headers[name]; if (Array.isArray(value)) throw new RequestError(400, 'Ambiguous header.'); return value;
}
function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('aborted', aborted); request.off('error', failed); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => failed(new RequestError(400, 'Incomplete webhook body.'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { request.pause(); failed(new RequestError(413, 'Webhook payload exceeds the configured limit.')); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    request.on('data', data); request.once('end', end); request.once('aborted', aborted); request.once('error', failed);
  });
}

export async function startWebhookServer(repository: string, config: NonNullable<ServiceConfig['webhook']>, secret: string,
  enqueue: (event: ServiceEvent) => Promise<'created' | 'duplicate'>) {
  if (secret.length < 32) throw new Error('Webhook secret must contain at least 32 characters.');
  const server = createServer((request, response) => {
    const reply = (status: number, message: string) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
      response.end(JSON.stringify({ message }));
    };
    void (async () => {
      if (request.url !== config.path) throw new RequestError(404, 'Unknown endpoint.');
      if (request.method !== 'POST') throw new RequestError(405, 'POST required.');
      if (header(request, 'content-type')?.split(';')[0]?.trim() !== 'application/json' || header(request, 'content-encoding'))
        throw new RequestError(415, 'Uncompressed application/json required.');
      const delivery = header(request, 'x-github-delivery'), event = header(request, 'x-github-event');
      if (!delivery || !/^[a-zA-Z0-9-]{1,100}$/.test(delivery) || !event || !/^[a-z_]{1,100}$/.test(event))
        throw new RequestError(400, 'GitHub delivery and event headers required.');
      const length = Number(header(request, 'content-length') ?? 0);
      if (length > config.maxBodyBytes) throw new RequestError(413, 'Webhook payload exceeds the configured limit.');
      const body = await readBody(request, config.maxBodyBytes);
      if (!validWebhookSignature(body, header(request, 'x-hub-signature-256'), secret)) throw new RequestError(403, 'Invalid webhook signature.');
      let target: ReturnType<typeof webhookTarget>;
      try { target = webhookTarget(event, JSON.parse(body.toString('utf8')), repository); }
      catch { throw new RequestError(400, 'Invalid event or repository.'); }
      if (!target) { reply(200, 'Event ignored.'); return; }
      const result = await enqueue({ schemaVersion: 1, id: taskId([repository, delivery]), repository, delivery,
        digest: createHash('sha256').update(body).digest('hex'), source: 'webhook', event,
        receivedAt: new Date().toISOString(), ...target });
      reply(202, result === 'duplicate' ? 'Delivery already recorded.' : 'Delivery recorded.');
    })().catch(error => reply(error instanceof RequestError ? error.status : 503,
      error instanceof RequestError ? error.message : 'Delivery could not be recorded; retry later.'));
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); }); });
  return { address: server.address(), close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
  }) };
}
