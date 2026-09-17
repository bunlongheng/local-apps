// Unit: routes/machines.js - peer discovery bookkeeping and the machine endpoints, with the
// network and the db faked so the 2-miss removal rule and the response shapes are pinned.
const { test } = require('node:test');
const assert = require('node:assert');
const { appRecord, peerRecord } = require('../../lib/peers');

function fakeDb() {
  const machines = new Map(), remote = new Map();
  return {
    machines, remote,
    getApps: () => [{ id: 'local-1', name: 'Local 1' }],
    getMachines: () => [...machines.values()],
    upsertMachine: (m) => machines.set(m.id, { ...(machines.get(m.id) || {}), ...m }),
    deleteMachine: (id) => machines.delete(id),
    getRemoteApps: (id) => [...remote.values()].filter(r => !id || r.machine_id === id),
    syncRemoteApps: (id, apps) => { for (const a of apps) remote.set(`${id}/${a.id}`, { id: a.id, machine_id: id, name: a.name, status: a.status }); },
    deleteRemoteApps: (id) => { for (const k of [...remote.keys()]) if (k.startsWith(`${id}/`)) remote.delete(k); },
  };
}
function fakeApp() {
  const routes = {}, app = {};
  for (const m of ['get', 'post', 'put', 'delete']) app[m] = (p, fn) => { routes[`${m.toUpperCase()} ${p}`] = fn; };
  return { app, routes };
}
function call(fn, params = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ params, query: {}, headers: {} }, res);
  });
}
function boot({ peers = [], statusByIp = {} } = {}) {
  const db = fakeDb(); const { app, routes } = fakeApp();
  const ctx = {
    appRecord, peerRecord, db, dbg: () => {}, IS_HUB: true, IS_MAIN: false, MACHINE_ROLE: 'hub', PORT: 9875,
    LAN_IP: () => '10.0.0.5', MACHINE_MODEL: () => 'Mac mini',
    sweepSubnet: async (lanIp, probe) => (await Promise.all(peers.map(ip => probe(ip)))).filter(Boolean),
    fetchJson: async (url) => {
      const ip = new URL(url).hostname;
      if (url.endsWith('/api/machine')) { if (!peers.includes(ip)) throw new Error('refused'); return { hostname: `host-${ip}`, model: 'MacBook', appCount: 1 }; }
      if (url.endsWith('/api/status')) { if (!statusByIp[ip]) throw new Error('unreachable'); return statusByIp[ip]; }
      throw new Error('unexpected ' + url);
    },
  };
  const { discoverPeers } = require('../../routes/machines')(app, ctx);
  return { db, routes, discoverPeers, ctx, peers };
}

test('a discovered peer lands in the db with its sanitised apps', async () => {
  const { db, discoverPeers } = boot({ peers: ['10.0.0.7'], statusByIp: { '10.0.0.7': { apps: [{ id: 'remote-a', name: 'A', status: 'up', localPath: '/Users/x' }] } } });
  await discoverPeers();
  assert.equal(db.getMachines().length, 1); assert.equal(db.getMachines()[0].ip, '10.0.0.7');
  assert.equal(db.getRemoteApps().length, 1);
});

test('a peer is removed only after 2 consecutive missed sweeps, and 1 reappearance resets the count', async () => {
  const t = boot({ peers: ['10.0.0.7'] });
  await t.discoverPeers();
  const id = t.db.getMachines()[0].id;
  t.peers.length = 0;                       // sweep 1: gone
  await t.discoverPeers();
  assert.ok(t.db.machines.has(id), 'kept after 1 miss (sleeping laptop)');
  t.peers.push('10.0.0.7');                 // back for 1 sweep
  await t.discoverPeers();
  t.peers.length = 0;                       // miss again: count restarts at 1
  await t.discoverPeers();
  assert.ok(t.db.machines.has(id), 'a reappearance resets the miss count');
  await t.discoverPeers();                  // miss 2 in a row
  assert.ok(!t.db.machines.has(id), 'dropped after 2 consecutive misses');
  assert.equal(t.db.getRemoteApps(id).length, 0, 'its remote apps go with it');
});

test('GET /api/machines/:id/status: 404 unknown, 502 unreachable, sanitised apps when reachable', async () => {
  const t = boot({ peers: ['10.0.0.7'], statusByIp: { '10.0.0.7': { apps: [{ id: 'remote-a', name: 'A', status: 'up' }], machineModel: 'MacBook Pro', lanIp: '10.0.0.7' } } });
  await t.discoverPeers();
  const id = t.db.getMachines()[0].id;
  const fn = t.routes['GET /api/machines/:id/status'];
  assert.equal((await call(fn, { id: 'nope' })).status, 404);
  const ok = await call(fn, { id });
  assert.equal(ok.status, 200); assert.equal(ok.body.apps.length, 1); assert.equal(ok.body.apps[0].id, 'remote-a'); assert.equal(ok.body.machineModel, 'MacBook Pro');
  delete t.ctx.fetchJson; t.ctx.fetchJson = async () => { throw new Error('timeout'); };
  const t2 = boot({ peers: ['10.0.0.8'] }); await t2.discoverPeers();
  const down = await call(t2.routes['GET /api/machines/:id/status'], { id: t2.db.getMachines()[0].id });
  assert.equal(down.status, 502);
});

test('GET /api/machine describes this machine; GET /api/machines lists peers', async () => {
  const t = boot({ peers: ['10.0.0.7'] });
  const me = await call(t.routes['GET /api/machine']);
  assert.equal(me.body.role, 'hub'); assert.equal(me.body.lanIp, '10.0.0.5'); assert.equal(me.body.port, 9875); assert.equal(me.body.appCount, 1);
  await t.discoverPeers();
  const list = await call(t.routes['GET /api/machines']);
  assert.ok(Array.isArray(list.body)); assert.equal(list.body.length, 1);
});
