import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { startDashboard } from '../src/adapters/dashboard/server.js';
import { dashboardSnapshot } from '../src/application/dashboard.js';
import { FileDecisionStore } from '../src/adapters/storage/decision-store.js';
import { FileDecisionGovernanceStore } from '../src/adapters/storage/decision-governance-store.js';
import { serviceFixture } from './service-helpers.js';

async function fixture() {
  const { d } = await serviceFixture();
  const decisions = new FileDecisionStore(d.config.dataDir), governance = new FileDecisionGovernanceStore(d.config.dataDir);
  const snapshot = () => dashboardSnapshot(d.config, '1.8.0', { candidates: d.candidates, goals: d.goals, reports: d.store, decisions, governance, services: d.services });
  return { d, decisions, governance, snapshot };
}

test('read-only loopback console requires its own token and rejects cross-origin, mutation and file requests', async () => {
  const { snapshot } = await fixture(); let reads = 0;
  const dashboard = await startDashboard({ snapshot: async () => { reads++; return snapshot(); } }, 0);
  const base = dashboard.url.split('/#')[0]!;
  try {
    const home = await fetch(base); assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const html = await home.text(); assert.ok(!html.includes(dashboard.token)); assert.ok(!html.includes('innerHTML'));
    assert.equal((await fetch(base + '/api/snapshot')).status, 401);
    assert.equal((await fetch(base + '/api/snapshot', { headers: { Authorization: 'Bearer ' + dashboard.token, Origin: 'https://evil.invalid' } })).status, 403);
    const rebound = await new Promise<number>((resolve, reject) => {
      const call = request(base + '/api/snapshot', { headers: { Authorization: 'Bearer ' + dashboard.token, Host: 'evil.invalid' } }, response => {
        response.resume(); resolve(response.statusCode!);
      }); call.on('error', reject); call.end();
    });
    assert.equal(rebound, 403);
    assert.equal((await fetch(base + '/api/snapshot', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/.env')).status, 404);
    assert.equal((await fetch(base + '/api/snapshot', { headers: { Authorization: 'Bearer ' + dashboard.token } })).status, 200);
    assert.equal(reads, 1);
  } finally { await dashboard.close(); }
});

test('console snapshots expose bounded summaries without Issue prose, review notes, logs, source paths or other repositories', async () => {
  const { d, snapshot } = await fixture();
  await d.candidates.save({ schemaVersion: 1, id: 'a'.repeat(24), repository: d.config.repository, kind: 'issue', evidenceDigest: 'b'.repeat(24),
    commit: 'c'.repeat(40), title: '<script>SECRET_TITLE</script>', detail: 'SECRET_ISSUE', priority: 1, priorityReasons: ['SECRET_REASON'],
    status: 'observed', firstSeenAt: '', updatedAt: '', reason: 'SECRET_LOCAL_PATH' });
  await d.candidates.save({ ...(await d.candidates.list())[0]!, id: 'd'.repeat(24), repository: 'foreign/repo' });
  const value = await snapshot(), text = JSON.stringify(value);
  assert.equal(value.counts.candidates, 1); assert.equal(value.candidates.length, 1);
  assert.ok(!text.includes('SECRET_')); assert.ok(!text.includes('foreign/repo')); assert.ok(!text.includes(d.config.dataDir));
});

test('console errors are sanitized and occupied ports fail without leaking listeners', async () => {
  const broken = await startDashboard({ snapshot: async () => { throw new Error('SECRET provider key'); } }, 0);
  try {
    const response = await fetch(broken.url.split('/#')[0] + '/api/snapshot', { headers: { Authorization: 'Bearer ' + broken.token } });
    assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('SECRET'));
  } finally { await broken.close(); }
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try { await assert.rejects(startDashboard({ snapshot: async () => { throw new Error('unused'); } }, address.port), /EADDRINUSE/); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
