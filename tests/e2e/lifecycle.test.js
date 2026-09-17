// e2e: the positive path. Register a throwaway app on a free port, read it back, change it,
// delete it - and the machine endpoints answer with the documented shapes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const http = require('node:http');
const { api, serverUp } = require('./helpers');

const ID = 'zzz-e2e-lifecycle';
// Mutating: opt in explicitly so `npm run test:e2e` against the live hub never provisions anything.
const MUTATE = process.env.E2E_MUTATE === '1';
const opts = { skip: MUTATE ? false : 'set E2E_MUTATE=1 against a scratch instance' };
// What caddy answers for the app's hostname on :80: 'offline' when the block is live (the upstream
// port is dead, so handle_errors serves public/offline.html), 'proxied' for anything else the block
// returns, 'none' when nothing serves that host.
// node:http, not fetch(): fetch drops a caller-set Host header, and Host is how caddy picks the site.
function viaCaddy() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 80, path: '/', headers: { host: `${ID}.localhost` }, timeout: 3000 }, (r) => {
      let body = ''; r.on('data', (c) => { body += c; });
      r.on('end', () => resolve(r.statusCode === 502 || body.includes('<title>App is off</title>') ? 'offline' : `proxied ${r.statusCode} ${body.slice(0, 200)}`));
    });
    req.on('error', () => resolve('none')); req.on('timeout', () => { req.destroy(); resolve('none'); });
  });
}
function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }

before(async () => { if (!await serverUp()) throw new Error('local-apps server not reachable - start it first'); if (MUTATE) await api('DELETE', `/api/apps/${ID}`); });
after(async () => { if (MUTATE) await api('DELETE', `/api/apps/${ID}`); });

test('POST -> GET -> PUT -> DELETE round-trips an app', opts, async () => {
  const port = await freePort();
  const created = await api('POST', '/api/apps', { id: ID, name: 'E2E Lifecycle', localPath: '/tmp/zzz-e2e', localUrl: `http://localhost:${port}`, healthUrl: `http://localhost:${port}`, tabColor: '#123456', prodUrl2: 'https://two.example.com' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.assignedPort, port);

  const got = await api('GET', `/api/apps/${ID}`);
  assert.equal(got.status, 200); assert.equal(got.json.name, 'E2E Lifecycle'); assert.equal(got.json.tabColor, '#123456'); assert.equal(got.json.prodUrl2, 'https://two.example.com');

  // On macOS the server provisions for real: the answer must carry the proxy and the agent, and
  // when the scratch paths are known the block and the plist must exist right now.
  if (process.platform === 'darwin') {
    assert.equal(got.json.caddyUrl, `http://${ID}.localhost`, 'Caddy block was written and reported');
    assert.match(String(got.json.launchAgent), new RegExp(`\\.${ID}$`), 'LaunchAgent label reported');
    if (process.env.CADDYFILE) assert.ok(fs.readFileSync(process.env.CADDYFILE, 'utf8').includes(`${ID}.localhost`), 'block present in the Caddyfile');
    if (process.env.LAUNCH_AGENTS_DIR) assert.ok(fs.existsSync(got.json.launchAgentPath) && got.json.launchAgentPath.startsWith(process.env.LAUNCH_AGENTS_DIR), 'plist present in the scratch dir');
    // With a live caddy the reload must have taken: the host proxies (to a dead port, so 502), not 404.
    if (process.env.CADDY_LIVE === '1') assert.equal(await viaCaddy(), 'offline', 'caddy serves the new block and its offline page');
  }

  const status = await api('GET', '/api/status');
  assert.ok(status.json.apps.some(a => a.id === ID), 'the new app is in /api/status');

  const put = await api('PUT', `/api/apps/${ID}`, { name: 'E2E Renamed' });
  assert.equal(put.status, 200); assert.equal((await api('GET', `/api/apps/${ID}`)).json.name, 'E2E Renamed');

  const del = await api('DELETE', `/api/apps/${ID}`);
  assert.equal(del.status, 200);
  if (process.platform === 'darwin' && process.env.CADDYFILE) assert.ok(!fs.readFileSync(process.env.CADDYFILE, 'utf8').includes(`${ID}.localhost`), 'block removed');
  if (process.platform === 'darwin' && got.json.launchAgentPath) assert.ok(!fs.existsSync(got.json.launchAgentPath), 'plist removed');
  if (process.platform === 'darwin' && process.env.CADDY_LIVE === '1') assert.notEqual(await viaCaddy(), 'offline', 'caddy dropped the block');
  assert.equal((await api('GET', `/api/apps/${ID}`)).status, 404);
});

test('GET /api/machine and /api/machines answer with their shapes', async () => {
  const me = await api('GET', '/api/machine');
  assert.equal(me.status, 200); assert.ok(['hub', 'agent'].includes(me.json.role)); assert.equal(typeof me.json.hostname, 'string'); assert.equal(typeof me.json.appCount, 'number');
  const list = await api('GET', '/api/machines');
  assert.equal(list.status, 200); assert.ok(Array.isArray(list.json));
  assert.equal((await api('GET', '/api/machines/zzz-no-such-machine/status')).status, 404);
});
