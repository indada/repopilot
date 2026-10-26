import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { DashboardReader } from '../../ports/dashboard.js';
import { dashboardPage } from './page.js';

/** Standalone loopback reader: no mutation routes, files, CORS, provider credentials or controller ownership. */
export async function startDashboard(reader: DashboardReader, port = 8788) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid dashboard port.');
  const token = randomBytes(32).toString('hex'); let authority = '';
  const server = createServer((request, response) => {
    const nonce = randomBytes(18).toString('base64');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    const reply = (status: number, body: string, type = 'application/json') => {
      response.writeHead(status, { 'Content-Type': type + '; charset=utf-8' }); response.end(body);
    };
    void (async () => {
      if (request.headers.host !== authority || request.headers.origin && request.headers.origin !== 'http://' + authority
        || request.headers['sec-fetch-site'] === 'cross-site') { reply(403, '{"error":"Local origin required."}'); return; }
      if (request.method !== 'GET') { reply(405, '{"error":"Read-only endpoint."}'); return; }
      if (request.url === '/') { reply(200, dashboardPage(nonce), 'text/html'); return; }
      if (request.url !== '/api/snapshot') { reply(404, '{"error":"Unknown endpoint."}'); return; }
      const authorization = request.headers.authorization, expected = 'Bearer ' + token;
      if (!authorization || Buffer.byteLength(authorization) !== Buffer.byteLength(expected)
        || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) { reply(401, '{"error":"Local session token required."}'); return; }
      const snapshot = JSON.stringify(await reader.snapshot());
      if (Buffer.byteLength(snapshot) > 1048576) throw new Error('Snapshot exceeds the console limit.');
      reply(200, snapshot);
    })().catch(() => { if (!response.writableEnded && !response.destroyed) reply(503, '{"error":"Local evidence temporarily unavailable."}'); });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Dashboard listener has no TCP address.');
  authority = '127.0.0.1:' + address.port;
  return { url: 'http://' + authority + '/#token=' + token, token,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
