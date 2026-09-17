// Route-level security tests: import the real app (IS_MAIN=false, so no listener /
// health loops / peer probes start) against an isolated temp DB, listen on an ephemeral port,
// and assert the input-validation guards reject the audit's injection/traversal vectors.
// Requests originate from 127.0.0.1 (loopback = trusted by the auth gate), so these isolate the
// per-route validation from the auth policy (which lib/auth-gate.test.js covers directly).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `local-apps-routes-${process.pid}.db`);
process.env.LOCAL_APPS_DB = TMP_DB;
process.env.MACHINE_ROLE = 'hub';   // the hub registers every route; do not depend on machine-role.json
const app = require('../../server');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (server) server.close();
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TMP_DB + s); } catch { /* not created */ } }
});

async function req(method, p, body) {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(body); }
  const r = await fetch(base + p, opts);
  return r.status;
}

test('sanity: GET /api/status works from loopback', async () => {
  assert.equal(await req('GET', '/api/status'), 200);
});

test('POST /api/apps rejects a launchAgent injection payload (the RCE vector)', async () => {
  assert.equal(await req('POST', '/api/apps', { id: 'zzz-evil', launchAgent: 'x; touch /tmp/pwned; #' }), 400);
  assert.equal(await req('POST', '/api/apps', { id: 'zzz-evil', launchAgentPath: '/tmp/a";evil.plist' }), 400);
});

test('PUT /api/app-profiles/:id cannot rewrite exec-bound fields', async () => {
  // Seed through db.js: POST /api/apps provisions a LaunchAgent + Caddy entry, which is
  // macOS-only and not what this test is about.
  require('../../db').upsertApp({ id: 'zzz-prof', localPath: '/tmp/zzz-prof', launchAgent: 'com.example.zzz-prof', startCommand: 'npm run dev' });
  assert.equal(await req('PUT', '/api/app-profiles/zzz-prof', { about: 'x', launchAgent: 'evil; touch /tmp/pwned', startCommand: 'rm -rf /' }), 200);
  const r = await fetch(base + '/api/apps/zzz-prof'); const a = await r.json();
  assert.equal(a.about, 'x');
  assert.notEqual(a.launchAgent, 'evil; touch /tmp/pwned');
  assert.notEqual(a.startCommand, 'rm -rf /');
});

test('log, start, stop and events routes: 404 on unknown ids, SSE headers on events', async () => {
  assert.equal(await req('GET', '/api/log/zzz-missing'), 404);
  assert.equal(await req('POST', '/api/start/zzz-missing'), 404);
  assert.equal(await req('POST', '/api/stop/zzz-missing'), 404);
  const ctrl = new AbortController();
  const r = await fetch(base + '/api/events', { signal: ctrl.signal });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/event-stream/);
  ctrl.abort();
});

test('HTTP layer: X-Forwarded-For from a loopback socket demotes the caller (the Caddy path)', async () => {
  const r = await fetch(base + '/api/apps/zzz-prof', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.equal(a.localPath, undefined, 'proxied LAN viewer must not see paths');
  const w = await fetch(base + '/api/stop/zzz-prof', { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(w.status, 401, 'proxied LAN mutation is denied');
});

// start/stop on a registered app run launchctl and lsof; that path is covered with spies in
// routes-apps.test.js so this file never touches the host.

test('meta: manifest label follows the host, favicons map is /favicons/<file>?v=, qr is a data URL, profiles carry the 7 keys', async () => {
  // fetch() drops a caller-set Host header, so the manifest probe goes through node:http.
  const http = require('node:http');
  const man = (host) => new Promise((resolve, reject) => http.get(base + '/api/manifest', { headers: { host } }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
  // Only hosts the auth gate allows (loopback, *.localhost, this machine's LAN ip) reach the handler:
  // an arbitrary Host header is a DNS-rebinding attempt and is refused before routing.
  assert.equal((await man('local-apps.localhost')).name, 'Apps (Caddy)');
  assert.equal((await man('localhost:9875')).start_url, 'http://localhost:9875/');
  assert.equal((await man('evil.example:9875')).name, undefined, 'foreign Host never reaches the manifest');
  const fav = await (await fetch(base + '/api/favicons')).json();
  assert.ok(Object.keys(fav).length > 0);
  for (const [id, v] of Object.entries(fav)) assert.match(v, new RegExp(`^/favicons/${id}\\.(png|svg|ico)\\?v=\\d+$`));
  const qr = await (await fetch(base + '/api/qr')).json();
  assert.match(qr.dataUrl, /^data:image\/png;base64,/); assert.match(qr.url, /^http:\/\/.+:\d+$/);
  const prof = await (await fetch(base + '/api/app-profiles')).json();
  assert.deepEqual(Object.keys(prof['zzz-prof']).sort(), ['about', 'architect', 'deploy', 'features', 'performance', 'prompt', 'security']);
  assert.equal(prof['zzz-prof'].about, 'x');
});

test('meta: /api/consistency?id= is sanitised to [a-z0-9-] and audits that app only', async () => {
  const r = await fetch(base + '/api/consistency?id=zzz-prof%3B%20rm');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body) && body.length === 1, '1 app audited, not the whole registry');
  assert.equal(body[0].id, 'zzz-profrm', 'shell metacharacters are stripped from the id before any file check');
});

test('/api/status says whether the viewer is on the box; the SSE stream pings every 25s', async () => {
  const { mock } = require('node:test');
  assert.equal((await (await fetch(base + '/api/status')).json()).viewer, 'loopback');
  assert.equal((await (await fetch(base + '/api/status', { headers: { 'x-forwarded-for': '1.2.3.4' } })).json()).viewer, 'offbox');
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const http = require('node:http');
    const frame = await new Promise((resolve, reject) => {
      const rq = http.get(base + '/api/events', (r) => {
        assert.match(r.headers['content-type'], /text\/event-stream/);
        r.once('data', (c) => { resolve(String(c)); rq.destroy(); });
        setImmediate(() => mock.timers.tick(25000));   // the handler's interval is registered once headers are out
      });
      rq.on('error', reject);
    });
    assert.equal(frame, ': ping\n\n');
  } finally { mock.timers.reset(); }
});

test('/api/log/:id returns exactly the last 30 lines of a log larger than the 64KB tail, and [] for a missing file', async () => {
  const db = require('../../db');
  const logPath = path.join(os.tmpdir(), `zzz-log-${process.pid}.log`);
  const lines = []; for (let i = 1; i <= 200; i++) lines.push(`line ${String(i).padStart(4, '0')} ` + 'x'.repeat(1000));
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  db.upsertApp({ id: 'zzz-log', localPath: '/tmp/zzz-log', logPath });
  const got = (await (await fetch(base + '/api/log/zzz-log')).json()).lines;
  assert.equal(got.length, 30); assert.deepEqual(got, lines.slice(-30));
  fs.unlinkSync(logPath);
  assert.deepEqual(await (await fetch(base + '/api/log/zzz-log')).json(), { lines: [] });
  db.upsertApp({ id: 'zzz-nolog', localPath: '/tmp/zzz-nolog' });
  assert.deepEqual(await (await fetch(base + '/api/log/zzz-nolog')).json(), { lines: [] }, 'no logPath configured');
});
