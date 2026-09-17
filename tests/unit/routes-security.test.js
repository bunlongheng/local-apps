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
