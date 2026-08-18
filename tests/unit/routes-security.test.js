// Route-level security tests: import the real Express app (IS_MAIN=false, so no listener /
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
const app = require('../../server');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (server) server.close();
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
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
