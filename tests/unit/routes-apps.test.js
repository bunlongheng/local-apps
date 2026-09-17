// Unit: routes/apps.js - the mutating handlers with every host effect faked: toggle OFF boots out then
// frees the port, ON kickstarts, bulk-toggle keeps ids, PUT re-provisions, DELETE tears down before
// the row is gone, POST merges the provisioned infra, stop kills the port and marks down.
const { test, mock } = require('node:test');
const assert = require('node:assert');

function fakeDb(apps) {
  const rows = new Map(apps.map(a => [a.id, { ...a }]));
  return {
    rows, getApps: () => [...rows.values()], getApp: (id) => rows.get(id) || null,
    setAppDisabled: (id, v) => { rows.get(id).disabled = v; }, deleteApp: (id) => rows.delete(id),
    upsertApp: (d) => { rows.set(d.id, { ...(rows.get(d.id) || {}), ...d }); return rows.get(d.id); },
  };
}
function fakeApp() {
  const routes = {}, app = {};
  for (const m of ['get', 'post', 'put', 'delete']) app[m] = (p, fn) => { routes[`${m.toUpperCase()} ${p}`] = fn; };
  return { app, routes };
}
function call(fn, { params = {}, body = {} } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    const out = fn({ params, body, query: {}, headers: {}, socket: { remoteAddress: '127.0.0.1' }, get: () => undefined }, res);
    if (out && out.catch) out.catch((e) => resolve({ status: 500, body: { error: e.message } }));
  });
}
function boot(apps) {
  const calls = [], db = fakeDb(apps), states = {}; const { app, routes } = fakeApp();
  const ctx = {
    LAN_IP: () => '10.0.0.5', TAILSCALE_IP: () => null, MACHINE_MODEL: () => 'Mac', isLoopback: () => true, clientAddress: () => '127.0.0.1',
    bootoutCmd: (u, l) => `bootout ${l}`, startCmd: (u, l) => `start ${l}`, PORT: 9875, MACHINE_ROLE: 'hub',
    getNextAvailablePort: () => 3999, isPortTaken: () => null, killPort: async (p) => calls.push(`killPort:${p}`), db, dbg: () => {},
    broadcast: (e) => calls.push(`sse:${e.type}:${e.id || ''}:${e.status || ''}`), sseClients: new Set(),
    getState: (id) => (states[id] ||= { status: 'up' }), clearState: (id) => calls.push(`clearState:${id}`), checkSingle: () => {},
    setupInfra: (id, data) => { calls.push(`setupInfra:${id}:${data.localUrl || ''}`); return { caddyUrl: `http://${id}.localhost`, launchAgent: `com.t.${id}` }; },
    teardownInfra: async (a) => calls.push(`teardown:${a.id}:${db.getApp(a.id) ? 'row-present' : 'row-gone'}`),
    updateTabColors: () => {}, forViewer: (req, a) => a, execAsync: async (cmd) => calls.push(`exec:${cmd}`), spawn: (bin, args) => { calls.push(`spawn:${args[1]}`); return { unref() {} }; },
    validateAppFields: () => null, isValidId: (id) => /^[a-z0-9-]+$/.test(id), isChromeExtensionRepo: () => false, CHROME_EXT_ERROR: 'ext', addCaddyEntry: () => {}, renameCaddyEntry: () => {},
  };
  require('../../routes/apps')(app, ctx);
  return { routes, calls, db, states };
}
const A = { id: 'a', name: 'A', localUrl: 'http://localhost:4000', launchAgent: 'com.t.a', launchAgentPath: '/tmp/a.plist', disabled: false };
const B = { id: 'b', name: 'B', localUrl: 'http://localhost:4001', launchAgent: 'com.t.b', launchAgentPath: '/tmp/b.plist', disabled: false };

test('toggle OFF boots out, then frees the port, marks down and broadcasts; toggle ON kickstarts', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { routes, calls, db, states } = boot([A]);
  const off = await call(routes['POST /api/apps/:id/toggle'], { params: { id: 'a' } });
  assert.deepEqual(off.body, { id: 'a', disabled: true }); assert.equal(db.getApp('a').disabled, true);
  assert.deepEqual(calls, ['exec:bootout com.t.a', 'killPort:4000', 'sse:update:a:down']); assert.equal(states.a.status, 'down');
  calls.length = 0;
  const on = await call(routes['POST /api/apps/:id/toggle'], { params: { id: 'a' } });
  assert.deepEqual(on.body, { id: 'a', disabled: false }); assert.deepEqual(calls, ['exec:start com.t.a']);
  assert.equal((await call(routes['POST /api/apps/:id/toggle'], { params: { id: 'zzz' } })).status, 404);
  mock.timers.reset();
});

test('bulk-toggle keeps the listed ids, boots out + frees only newly disabled apps, kickstarts newly enabled ones', async () => {
  const { routes, calls, db } = boot([A, { ...B, disabled: true }]);
  const r = await call(routes['POST /api/apps/bulk-toggle'], { body: { keep: ['b'] } });
  assert.deepEqual(r.body.results, [{ id: 'a', disabled: true }, { id: 'b', disabled: false }]);
  assert.equal(db.getApp('a').disabled, true); assert.equal(db.getApp('b').disabled, false);
  assert.deepEqual(calls.sort(), ['exec:bootout com.t.a', 'exec:start com.t.b', 'killPort:4000', 'sse:update:a:down'].sort());
});

test('POST merges the provisioned infra and reports the assigned port; PUT with localUrl re-provisions', async () => {
  const { routes, calls, db } = boot([A]);
  const c = await call(routes['POST /api/apps'], { body: { id: 'new', localPath: '/srv/new' } });
  assert.equal(c.status, 201); assert.equal(c.body.caddyUrl, 'http://new.localhost'); assert.equal(c.body.launchAgent, 'com.t.new');
  assert.ok(calls.includes('setupInfra:new:') && calls.includes('sse:reload::'));
  assert.equal(c.body.assignedPort, null, 'no localUrl came back from the fake provisioner');
  calls.length = 0;
  const u = await call(routes['PUT /api/apps/:id'], { params: { id: 'a' }, body: { localUrl: 'http://localhost:4100' } });
  assert.equal(u.status, 200); assert.equal(db.getApp('a').localUrl, 'http://localhost:4100');
  assert.deepEqual(calls, ['setupInfra:a:http://localhost:4100', 'sse:reload::']);
  calls.length = 0;
  await call(routes['PUT /api/apps/:id'], { params: { id: 'a' }, body: { name: 'Renamed' } });
  assert.ok(!calls.some(x => x.startsWith('setupInfra')), 'a rename alone does not re-provision');
});

test('DELETE tears down while the row still exists, then removes it and clears state', async () => {
  const { routes, calls, db } = boot([A]);
  const r = await call(routes['DELETE /api/apps/:id'], { params: { id: 'a' } });
  assert.deepEqual(r.body, { ok: true }); assert.equal(db.getApp('a'), null);
  assert.deepEqual(calls, ['teardown:a:row-present', 'clearState:a', 'sse:update:a:removed']);
  assert.equal((await call(routes['DELETE /api/apps/:id'], { params: { id: 'a' } })).status, 404);
});

test('stop kills the port, boots out in the background and marks down; start kickstarts; both 400 without a LaunchAgent', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { routes, calls, states } = boot([A, { id: 'c', name: 'C' }]);
  assert.deepEqual((await call(routes['POST /api/stop/:id'], { params: { id: 'a' } })).body, { ok: true });
  assert.deepEqual(calls, ['killPort:4000', 'spawn:bootout com.t.a', 'sse:update:a:down']); assert.equal(states.a.status, 'down');
  calls.length = 0;
  assert.deepEqual((await call(routes['POST /api/start/:id'], { params: { id: 'a' } })).body, { ok: true }); assert.deepEqual(calls, ['spawn:start com.t.a']);
  assert.equal((await call(routes['POST /api/start/:id'], { params: { id: 'c' } })).status, 400);
  assert.equal((await call(routes['POST /api/stop/:id'], { params: { id: 'c' } })).status, 400);
  mock.timers.reset();
});
