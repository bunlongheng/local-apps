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
process.env.MACHINE_ROLE = 'hub';
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
process.env.LOCAL_APPS_HOME = SCRATCH_HOME; process.env.LOCAL_APPS_LOG_DIR = path.join(SCRATCH_HOME, 'logs');   // the hub registers every route; do not depend on machine-role.json
process.env.LOCAL_APPS_TOKEN = 'zzz-tok';   // exercises the header wiring; loopback callers never need it
// Favicons come from a seeded temp dir, so the suite never depends on what public/favicons holds.
const FAV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'favs-'));
fs.writeFileSync(path.join(FAV_DIR, 'zzz-fav.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
process.env.LOCAL_APPS_FAVICONS_DIR = FAV_DIR;
// The import must be hermetic (no shell-out, writes only under the scratch home): see the helper.
const app = require('./helpers/hermetic-import')(SCRATCH_HOME);

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
const TMP_PATHS = [];   // fixture files and dirs, removed even when an assertion fails
after(() => {
  if (server) server.close();
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TMP_DB + s); } catch { /* not created */ } }
  for (const p of TMP_PATHS) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(FAV_DIR, { recursive: true, force: true });
  fs.rmSync(SCRATCH_HOME, { recursive: true, force: true });
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
  // Every stripped key, on every viewer route: a leaked logPath or startCommand is a real disclosure.
  const KEYS = app.OFFBOX_STRIP; assert.equal(KEYS.length, 13);
  for (const k of KEYS) assert.equal(a[k], undefined, `/api/apps/:id leaks ${k} off-box`);
  const list = await (await fetch(base + '/api/apps', { headers: { 'x-forwarded-for': '1.2.3.4' } })).json();
  const st = await (await fetch(base + '/api/status', { headers: { 'x-forwarded-for': '1.2.3.4' } })).json();
  for (const row of [list.find(x => x.id === 'zzz-prof'), st.apps.find(x => x.id === 'zzz-prof')]) for (const k of KEYS) assert.equal(row[k], undefined, `list/status leaks ${k} off-box`);
  const onbox = await (await fetch(base + '/api/apps/zzz-prof')).json();
  assert.equal(onbox.localPath, '/tmp/zzz-prof', 'loopback still sees everything');
  const w = await fetch(base + '/api/stop/zzz-prof', { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(w.status, 401, 'proxied LAN mutation is denied');
});

// start/stop on a registered app run launchctl and lsof; that path is covered with spies in
// routes-apps.test.js so this file never touches the host.

test('meta: manifest label follows the host, favicons map is /favicons/<file>?v=, qr is a data URL, profiles carry the 7 keys', async () => {
  // fetch() drops a caller-set Host header, so the manifest probe goes through node:http.
  const http = require('node:http');
  const man = (host) => new Promise((resolve, reject) => http.get(base + '/api/manifest', { headers: { host } }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(Object.assign(JSON.parse(b), { status: r.statusCode }))); }).on('error', reject));
  // Only hosts the auth gate allows (loopback, *.localhost, this machine's LAN ip) reach the handler:
  // an arbitrary Host header is a DNS-rebinding attempt and is refused before routing.
  assert.equal((await man('local-apps.localhost')).name, 'Apps (Caddy)');
  assert.equal((await man('localhost:9875')).start_url, 'http://localhost:9875/');
  const foreign = await man('evil.example:9875');
  assert.equal(foreign.status, 421, 'foreign Host is a DNS-rebinding attempt: 421'); assert.equal(foreign.name, undefined);
  assert.equal((await man('local-apps.localhost')).status, 200);
  const fav = await (await fetch(base + '/api/favicons')).json();
  assert.deepEqual(Object.keys(fav), ['zzz-fav']); assert.match(fav['zzz-fav'], /^\/favicons\/zzz-fav\.png\?v=\d+$/);
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

test('/api/status says whether the viewer is on the box; the SSE stream pings every 25s', async (t) => {
  assert.equal((await (await fetch(base + '/api/status')).json()).viewer, 'loopback');
  assert.equal((await (await fetch(base + '/api/status', { headers: { 'x-forwarded-for': '1.2.3.4' } })).json()).viewer, 'offbox');
  t.mock.timers.enable({ apis: ['setInterval'] });   // the context's tracker: restored pass or fail
  const http = require('node:http');
  const { headers, frame } = await new Promise((resolve, reject) => {
    const rq = http.get(base + '/api/events', (r) => {
      r.once('data', (c) => { resolve({ headers: r.headers, frame: String(c) }); rq.destroy(); });
      setImmediate(() => t.mock.timers.tick(25000));   // the handler's interval is registered once headers are out
    });
    rq.on('error', reject);
  });
  assert.match(headers['content-type'], /text\/event-stream/);
  assert.equal(frame, ': ping\n\n');
});

test('/api/log/:id returns exactly the last 30 lines of a log larger than the 64KB tail, and [] for a missing file', async () => {
  const db = require('../../db');
  const logPath = path.join(os.tmpdir(), `zzz-log-${process.pid}.log`); TMP_PATHS.push(logPath);
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

test('off-box callers are let through by x-local-apps-token and refused without it or with a wrong one', async () => {
  // zzz-auth has no launchAgent, so the toggle round-trip execs nothing and arms no timers on the host.
  require('../../db').upsertApp({ id: 'zzz-auth', localPath: '/tmp/zzz-auth' });
  const off = (p, method, token) => fetch(base + p, { method, headers: { 'x-forwarded-for': '1.2.3.4', ...(token ? { 'x-local-apps-token': token } : {}) } });
  assert.equal((await off('/api/log/zzz-prof', 'GET')).status, 401);
  assert.equal((await off('/api/log/zzz-prof', 'GET', 'wrong')).status, 401);
  assert.equal((await off('/api/log/zzz-prof', 'GET', 'zzz-tok')).status, 200);
  assert.equal((await off('/api/apps/zzz-auth/toggle', 'POST')).status, 401);
  const r = await off('/api/apps/zzz-auth/toggle', 'POST', 'zzz-tok');
  assert.equal(r.status, 200, 'a mutation with the token is allowed off-box'); assert.equal((await r.json()).disabled, true);
});

test('every response carries the security headers: frame denial, nosniff, a CSP with no inline scripts', async () => {
  for (const p of ['/', '/api/status']) {
    const r = await fetch(base + p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /script-src 'self'(;|$)/); assert.match(csp, /object-src 'none'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline scripts');
  }
});

test('POST and PUT /api/apps refuse a localPath whose repo root holds a Chrome extension manifest', async () => {
  const { CHROME_EXT_ERROR } = require('../../lib/chrome-ext');
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'zzz-ext-')); TMP_PATHS.push(ext);
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'x' }));
  const post = await fetch(base + '/api/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'zzz-ext', localPath: ext }) });
  assert.equal(post.status, 400); assert.equal((await post.json()).error, CHROME_EXT_ERROR);
  assert.equal((await fetch(base + '/api/apps/zzz-ext')).status, 404, 'nothing registered');
  const put = await fetch(base + '/api/apps/zzz-prof', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localPath: ext }) });
  assert.equal(put.status, 400); assert.equal((await put.json()).error, CHROME_EXT_ERROR);
  assert.equal((await (await fetch(base + '/api/apps/zzz-prof')).json()).localPath, '/tmp/zzz-prof', 'row unchanged');
});

test('the global error handler answers 500 with a fixed message: no exception detail leaks', async (t) => {
  const db = require('../../db');
  const m = t.mock.method(db, 'getApps', () => { throw new Error('secret detail'); });
  const err = t.mock.method(console, 'error', () => {});
  const r = await fetch(base + '/api/status');
  assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: 'Internal error' });
  assert.equal(err.mock.callCount(), 1); assert.match(String(err.mock.calls[0].arguments[0]), /secret detail/, 'the detail goes to the server log only');
  m.mock.restore(); err.mock.restore();
  assert.equal((await fetch(base + '/api/status')).status, 200, 'the server is fine afterwards');
});
