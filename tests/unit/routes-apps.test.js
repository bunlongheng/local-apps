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
function boot(apps, { taken = null, nextPort = 3999, tailscale = null } = {}) {
  const calls = [], db = fakeDb(apps), states = {}; const { app, routes } = fakeApp();
  const ctx = {
    LAN_IP: () => '10.0.0.5', TAILSCALE_IP: () => tailscale, MACHINE_MODEL: () => 'Mac', isLoopback: () => true, clientAddress: () => '127.0.0.1',
    bootoutCmd: (u, l) => `bootout ${l}`, startCmd: (u, l) => `start ${l}`, PORT: 9875, MACHINE_ROLE: 'hub',
    getNextAvailablePort: () => nextPort, isPortTaken: (p, ex) => (taken && taken.port === p && taken.id !== ex ? taken.id : null), killPort: async (p) => calls.push(`killPort:${p}`), db, dbg: () => {},
    broadcast: (e) => calls.push(`sse:${e.type}:${e.id || ''}:${e.status || ''}`), sseClients: new Set(),
    getState: (id) => (states[id] ||= { status: 'up' }), clearState: (id) => calls.push(`clearState:${id}`), checkSingle: (a) => calls.push(`recheck:${a.id}`),
    setupInfra: (id, data) => { calls.push(`setupInfra:${id}:${data.localUrl || ''}`); return { caddyUrl: `http://${id}.localhost`, launchAgent: `com.t.${id}` }; },
    teardownInfra: async (a) => calls.push(`teardown:${a.id}:${db.getApp(a.id) ? 'row-present' : 'row-gone'}`),
    updateTabColors: (id, name) => calls.push(`tabs:${id}:${name}`), forViewer: (req, a) => a, execAsync: async (cmd) => calls.push(`exec:${cmd}`), spawn: (bin, args) => { calls.push(`spawn:${args[1]}`); return { unref() {} }; },
    validateAppFields: () => null, isValidId: (id) => /^[a-z0-9-]+$/.test(id), isChromeExtensionRepo: () => false, CHROME_EXT_ERROR: 'ext', addCaddyEntry: (h, p) => calls.push(`caddy:add:${h}:${p}`), renameCaddyEntry: (o, n, p) => calls.push(`caddy:rename:${o}:${n}:${p}`),
  };
  require('../../routes/apps')(app, ctx);
  routes.__sse = ctx.sseClients;
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
  mock.timers.tick(15000); assert.equal(calls.filter(c => c === 'recheck:a').length, 3, 'toggle ON rechecks like start');
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
  assert.deepEqual(calls, ['setupInfra:a:http://localhost:4100', 'caddy:add:a:4100', 'sse:reload::'], 'provisioned host gets its block since the app had none');
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
  mock.timers.tick(15000);
  assert.equal(calls.filter(c => c === 'recheck:a').length, 3, 'health is rechecked at 3s, 8s and 15s after a start');
  assert.equal((await call(routes['POST /api/start/:id'], { params: { id: 'c' } })).status, 400);
  assert.equal((await call(routes['POST /api/stop/:id'], { params: { id: 'c' } })).status, 400);
  mock.timers.reset();
});

test('PUT renames the Caddy block when caddyUrl changes, adds one when there was none, and syncs the tab label on a rename', async () => {
  const { routes, calls } = boot([{ ...A, caddyUrl: 'http://a.localhost' }, { ...B, caddyUrl: null }]);
  await call(routes['PUT /api/apps/:id'], { params: { id: 'a' }, body: { caddyUrl: 'http://neu.localhost' } });
  assert.ok(calls.includes('caddy:rename:a:neu:4000'), calls.join());
  calls.length = 0;
  await call(routes['PUT /api/apps/:id'], { params: { id: 'b' }, body: { caddyUrl: 'http://bee.localhost' } });
  assert.ok(calls.includes('caddy:add:bee:4001'), calls.join());
  calls.length = 0;
  await call(routes['PUT /api/apps/:id'], { params: { id: 'a' }, body: { name: 'Renamed' } });
  assert.ok(calls.includes('tabs:a:Renamed'), calls.join()); assert.ok(!calls.some(x => x.startsWith('caddy:')), 'a rename alone touches no Caddy block');
});

test('PUT and POST answer 409 with a suggestion when the port belongs to another app; an app may keep its own port; no suggestion when the range is full', async () => {
  const { routes, db } = boot([A, B], { taken: { port: 4001, id: 'b' } });
  const r = await call(routes['PUT /api/apps/:id'], { params: { id: 'a' }, body: { localUrl: 'http://localhost:4001' } });
  assert.equal(r.status, 409); assert.match(r.body.error, /already used by "b"/); assert.equal(r.body.suggestedPort, 3999); assert.equal(r.body.suggestedUrl, 'http://localhost:3999');
  assert.equal(db.getApp('a').localUrl, 'http://localhost:4000', 'nothing written on a conflict');
  assert.equal((await call(routes['PUT /api/apps/:id'], { params: { id: 'b' }, body: { localUrl: 'http://localhost:4001' } })).status, 200, 'an app is not in conflict with itself');
  assert.equal((await call(routes['POST /api/apps'], { body: { id: 'new', localUrl: 'http://localhost:4001' } })).status, 409);
  const full = boot([A, B], { taken: { port: 4001, id: 'b' }, nextPort: null });
  const f = await call(full.routes['POST /api/apps'], { body: { id: 'new', localUrl: 'http://localhost:4001' } });
  assert.equal(f.status, 409); assert.equal(f.body.suggestedPort, null); assert.equal(f.body.suggestedUrl, null);
});

test('GET /api/status derives mode from the start command and rewrites LAN and Tailscale urls', async () => {
  const apps = [{ id: 'p', name: 'P', localUrl: 'http://localhost:4000', startCommand: 'npm start' }, { id: 'd', name: 'D', localUrl: 'http://localhost:4001', startCommand: 'npm run dev' }, { id: 'x', name: 'X', localUrl: 'http://localhost:4002', startCommand: 'next start --dev' }, { id: 'n', name: 'N' }];
  const t = boot(apps, { tailscale: '100.64.0.9' });
  const r = await call(t.routes['GET /api/status']);
  const by = Object.fromEntries(r.body.apps.map(a => [a.id, a]));
  assert.equal(by.p.mode, 'prod'); assert.equal(by.d.mode, 'dev'); assert.equal(by.x.mode, 'dev', 'a dev flag wins'); assert.equal(by.n.mode, 'dev');
  assert.equal(by.p.lanUrl, 'http://10.0.0.5:4000'); assert.equal(by.p.tailscaleUrl, 'http://100.64.0.9:4000'); assert.equal(by.n.lanUrl, null); assert.equal(by.n.tailscaleUrl, null);
  assert.equal(r.body.tailscaleIp, '100.64.0.9'); assert.equal(r.body.monitorUrl, 'http://10.0.0.5:9875');
  const off = await call(boot(apps).routes['GET /api/status']);
  assert.equal(off.body.apps[0].tailscaleUrl, null, 'no tailnet, no tailscale url');
});

test('an SSE client is tracked while connected; its heartbeat stops and it leaves the set on close', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { EventEmitter } = require('node:events');
    const { routes } = boot([A]);
    const sseClients = routes.__sse;   // exposed by boot below
    const writes = [];
    const res = Object.assign(new EventEmitter(), { setHeader() {}, flushHeaders() {}, write: (c) => writes.push(c) });
    routes['GET /api/events']({ params: {}, query: {}, headers: {}, get: () => undefined, socket: { remoteAddress: '127.0.0.1' } }, res);
    assert.equal(sseClients.size, 1, 'connected client tracked');
    mock.timers.tick(25000); assert.deepEqual(writes, [': ping\n\n'], 'heartbeat after 25s');
    res.emit('close');
    assert.equal(sseClients.size, 0, 'gone on close');
    mock.timers.tick(50000); assert.equal(writes.length, 1, 'no heartbeat after close: the interval was cleared');
  } finally { mock.timers.reset(); }
});
