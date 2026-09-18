// e2e: the positive path. Register a throwaway app on a free port, read it back, change it,
// delete it - and the machine endpoints answer with the documented shapes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
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
      // 'offline' needs the page itself: a bare 502 means the block proxies but handle_errors did not serve offline.html.
      r.on('end', () => resolve(body.includes('<title>App is off</title>') ? 'offline' : r.statusCode === 502 ? 'bare-502' : `proxied ${r.statusCode} ${body.slice(0, 200)}`));
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
  if (process.platform === 'darwin' && process.env.CADDY_LIVE === '1') { const gone = await viaCaddy(); assert.ok(!['offline', 'bare-502'].includes(gone), 'caddy dropped the block, got ' + gone); }
  assert.equal((await api('GET', `/api/apps/${ID}`)).status, 404);
});

test('GET /api/machine and /api/machines answer with their shapes', async () => {
  const me = await api('GET', '/api/machine');
  assert.equal(me.status, 200); assert.ok(['hub', 'agent'].includes(me.json.role)); assert.equal(typeof me.json.hostname, 'string'); assert.equal(typeof me.json.appCount, 'number');
  const list = await api('GET', '/api/machines');
  assert.equal(list.status, 200); assert.ok(Array.isArray(list.json));
  assert.equal((await api('GET', '/api/machines/zzz-no-such-machine/status')).status, 404);
});

test('hub-only routes answer on a hub and are 404 on an agent', async () => {
  const role = (await api('GET', '/api/status')).json.machineRole;
  if (role !== 'hub') {
    for (const p of ['/api/tab-colors', '/api/consistency', '/api/app-profiles', '/api/icon-sync', '/api/capabilities']) assert.equal((await api('GET', p)).status, 404, `${p} is not registered on an agent`);
    assert.equal((await api('PUT', '/api/app-profiles/zzz', { about: 'x' })).status, 404);
    return;
  }
  const tc = await api('GET', '/api/tab-colors'); assert.equal(tc.status, 200); assert.equal(typeof tc.json, 'object');
  const c = await api('GET', '/api/consistency?id=zzz-not-real'); assert.equal(c.status, 200); assert.ok(Array.isArray(c.json) && c.json.length === 1 && c.json[0].id === 'zzz-not-real');
  const prof = await api('GET', '/api/app-profiles'); assert.equal(prof.status, 200);
  assert.equal((await api('GET', '/api/machines')).status, 200);
});

// The launchd contract for real, macOS only: a tiny node server registered with its own start
// command must come up through POST /api/start (kickstart -k, falling back to enable + bootstrap +
// kickstart on a fresh label) and go down through POST /api/stop. Every earlier proof of this was
// a command string.
const LAUNCHD_ID = 'zzz-e2e-launchd';
// Can launchd start a user agent here at all? Bootstrap a probe that touches a file.
async function launchdWorks(execSync, os) {
  const fsx = require('node:fs'), pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'launchd-probe-'));
  const marker = pathx.join(dir, 'ran'), label = `com.zzz.probe.${process.pid}`, plist = pathx.join(dir, `${label}.plist`);
  fsx.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${marker}</string></array><key>RunAtLoad</key><false/></dict></plist>`);
  const run = (c) => { try { execSync(c, { stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; } };
  run(`launchctl bootout gui/${process.getuid()}/${label}`);
  run(`launchctl enable gui/${process.getuid()}/${label}`);
  run(`launchctl bootstrap gui/${process.getuid()} "${plist}"`);
  run(`launchctl kickstart -k gui/${process.getuid()}/${label}`);
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) { await new Promise((r) => setTimeout(r, 250)); ok = fsx.existsSync(marker); }
  run(`launchctl bootout gui/${process.getuid()}/${label}`);
  fsx.rmSync(dir, { recursive: true, force: true });
  return ok;
}
test('on macOS an app registered with a start command is started and stopped through launchd for real', { timeout: 120000, skip: !(MUTATE && process.platform === 'darwin' && process.env.LAUNCH_AGENTS_DIR) && 'needs E2E_MUTATE=1, macOS and a scratch LAUNCH_AGENTS_DIR' }, async (t) => {
  const os = require('node:os');
  const { execSync } = require('node:child_process');
  // Preflight: a CI runner without a real GUI session cannot bootstrap a user agent at all. Prove
  // launchd here can run one before blaming the product for a start that never happens.
  if (!(await launchdWorks(execSync, os))) return t.skip('launchd cannot run a user agent in this environment (no GUI session)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-app-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');\n`);
  await api('DELETE', `/api/apps/${LAUNCHD_ID}`);
  try {
    const created = await api('POST', '/api/apps', { id: LAUNCHD_ID, name: 'Launchd', localPath: dir, localUrl: `http://127.0.0.1:${port}`, healthUrl: `http://127.0.0.1:${port}`, startCommand: 'node server.js' });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.ok(fs.existsSync(created.json.launchAgentPath), 'plist written');
    assert.equal((await api('POST', `/api/start/${LAUNCHD_ID}`)).status, 200);
    const status = async () => (await api('GET', '/api/status')).json.apps.find((a) => a.id === LAUNCHD_ID).status;
    let up = false; for (let i = 0; i < 80 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = (await status()) === 'up'; }
    assert.ok(up, 'launchd brought the app up within 30s (launchctl print gui/' + process.getuid() + '/' + created.json.launchAgent + ')');
    assert.equal((await api('POST', `/api/stop/${LAUNCHD_ID}`)).status, 200);
    let down = false; for (let i = 0; i < 40 && !down; i++) { await new Promise((r) => setTimeout(r, 500)); down = (await status()) === 'down'; }
    assert.ok(down, 'stop brought it down');
    assert.throws(() => execSync(`launchctl print gui/${process.getuid()}/${created.json.launchAgent}`, { stdio: 'ignore' }), 'the service is no longer loaded after stop');
  } finally {
    await api('DELETE', `/api/apps/${LAUNCHD_ID}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
