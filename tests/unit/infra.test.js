// Unit: lib/infra.js - port allocation and the provisioning/teardown orchestration, with every
// host effect faked so the darwin branch runs on any OS.
const { test } = require('node:test');
const assert = require('node:assert');
const makeInfra = require('../../lib/infra');

function boot({ apps = [], canProvision = true } = {}) {
  const calls = [];
  const infra = makeInfra({
    canProvision, getApps: () => apps, uid: 501, logDir: '/tmp/logs', dbg: () => {}, log: () => {},
    addCaddyEntry: (id, port) => { calls.push(`caddy:add:${id}:${port}`); return `http://${id}.localhost`; },
    removeCaddyEntry: (host) => calls.push(`caddy:remove:${host}`),
    createLaunchAgent: (id, dir, logPath, cmd) => { calls.push(`la:create:${id}:${dir}:${logPath}:${cmd}`); return { launchAgent: `com.t.${id}`, launchAgentPath: `/tmp/${id}.plist` }; },
    removeLaunchAgent: (id) => calls.push(`la:remove:${id}`),
    killPort: async (p) => calls.push(`killPort:${p}`),
    exec: async (cmd) => calls.push(`exec:${cmd}`),
    bootoutCmd: (uid, label) => `bootout ${uid} ${label}`,
  });
  return { infra, calls };
}

test('isPortTaken counts localUrl and healthUrl and honours excludeId', () => {
  const { infra } = boot({ apps: [{ id: 'a', localUrl: 'http://localhost:3000' }, { id: 'b', healthUrl: 'http://localhost:3001/health' }] });
  assert.equal(infra.isPortTaken(3000), 'a'); assert.equal(infra.isPortTaken(3001), 'b');
  assert.equal(infra.isPortTaken(3000, 'a'), null); assert.equal(infra.isPortTaken(3002), null);
});

test('getNextAvailablePort skips used ports and returns null when the range is exhausted', () => {
  const { infra } = boot({ apps: [{ id: 'a', localUrl: 'http://localhost:3000' }, { id: 'b', healthUrl: 'http://localhost:3001' }] });
  assert.equal(infra.getNextAvailablePort(), 3002);
  const full = []; for (let p = infra.PORT_RANGE_START; p <= infra.PORT_RANGE_END; p++) full.push({ id: `p${p}`, localUrl: `http://localhost:${p}` });
  assert.equal(boot({ apps: full }).infra.getNextAvailablePort(), null);
});

test('setupInfra without a port auto-assigns one and provisions Caddy + LaunchAgent', () => {
  const { infra, calls } = boot({ apps: [{ id: 'a', localUrl: 'http://localhost:3000' }] });
  const r = infra.setupInfra('new', { localPath: '/srv/new', startCommand: 'npm start' });
  assert.equal(r.localUrl, 'http://localhost:3001'); assert.equal(r.healthUrl, 'http://localhost:3001');
  assert.equal(r.caddyUrl, 'http://new.localhost'); assert.equal(r.launchAgent, 'com.t.new'); assert.equal(r.logPath, '/tmp/logs/new.log');
  assert.deepEqual(calls, ['caddy:add:new:3001', 'la:create:new:/srv/new:/tmp/logs/new.log:npm start']);
});

test('setupInfra keeps a given port, skips the LaunchAgent without localPath, and does nothing off macOS', () => {
  const a = boot(); const r = a.infra.setupInfra('x', { localUrl: 'http://localhost:4100' });
  assert.equal(r.localUrl, undefined, 'caller port kept'); assert.equal(r.caddyUrl, 'http://x.localhost'); assert.equal(r.launchAgent, undefined);
  assert.deepEqual(a.calls, ['caddy:add:x:4100']);
  const b = boot({ canProvision: false }); const r2 = b.infra.setupInfra('y', { localPath: '/srv/y' });
  assert.equal(r2.localUrl, 'http://localhost:3000'); assert.equal(r2.caddyUrl, undefined); assert.deepEqual(b.calls, []);
});

test('teardownInfra frees the port, boots out, and removes the block the record points at (renamed host too)', async () => {
  const { infra, calls } = boot();
  await infra.teardownInfra({ id: 'a', localUrl: 'http://localhost:4200', launchAgent: 'com.t.a', caddyUrl: 'http://custom.localhost' });
  assert.deepEqual(calls, ['killPort:4200', 'exec:bootout 501 com.t.a', 'caddy:remove:custom', 'caddy:remove:a', 'la:remove:a']);
  const off = boot({ canProvision: false }); await off.infra.teardownInfra({ id: 'b', localUrl: 'http://localhost:4201' });
  assert.deepEqual(off.calls, ['killPort:4201'], 'off macOS only the port is freed');
});
