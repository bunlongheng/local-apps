// Unit: the fail-closed wiring in server.js with NO token configured, in its own process so the
// env is clean: every off-box mutation and sensitive read is 401 whether or not a header is sent.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `local-apps-notoken-${process.pid}.db`);
// node:test runs each file in its own process by default; should that ever change (an isolation flag,
// a shared runner), the cached server module from routes-security would carry its token, so fail loudly.
assert.equal(require.cache[require.resolve('../../server')], undefined, 'server must not be preloaded: this file needs its own process');
delete process.env.LOCAL_APPS_TOKEN;
process.env.LOCAL_APPS_DB = TMP_DB;
process.env.MACHINE_ROLE = 'hub';
const app = require('../../server');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  require('../../db').upsertApp({ id: 'zzz-nt', localPath: '/tmp/zzz-nt' });
});
after(() => { if (server) server.close(); for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TMP_DB + s); } catch { /* not created */ } } });

test('with no LOCAL_APPS_TOKEN, off-box control and sensitive reads are denied, with or without a header; loopback still works', async () => {
  const off = (p, method, token) => fetch(base + p, { method, headers: { 'x-forwarded-for': '1.2.3.4', ...(token ? { 'x-local-apps-token': token } : {}) } });
  assert.equal((await off('/api/apps/zzz-nt/toggle', 'POST')).status, 401);
  assert.equal((await off('/api/apps/zzz-nt/toggle', 'POST', 'anything')).status, 401, 'no configured token means no token can open the door');
  assert.equal((await off('/api/apps/zzz-nt/toggle', 'POST', '')).status, 401);
  assert.equal((await off('/api/log/zzz-nt', 'GET', 'anything')).status, 401);
  assert.equal((await off('/api/status', 'GET')).status, 200, 'plain status stays viewable off-box');
  assert.equal((await fetch(base + '/api/apps/zzz-nt/toggle', { method: 'POST' })).status, 200, 'loopback is trusted');
  assert.equal((await (await fetch(base + '/api/apps/zzz-nt')).json()).disabled, true);
});
