// Unit: lib/monitor.js - the tick executes what lib/tick.js decides: trip, re-arm, level, guard.
const { test } = require('node:test');
const assert = require('node:assert');
const makeMonitor = require('../../lib/monitor');
const { guardedTick } = makeMonitor;

function boot({ apps, decision, probe, getApps, killPort, exec }) {
  const calls = [], states = {};
  const m = makeMonitor({
    getApps: getApps || (() => apps), setAppDisabled: (id, v, why) => calls.push(`disable:${id}:${v}:${why || ''}`),
    probe: probe || (async () => false), getState: (id) => (states[id] ||= { status: 'unknown' }),
    decide: ({ s }) => { const d = typeof decision === 'function' ? decision(s) : decision; return { status: 'down', changed: false, rearm: null, trip: null, level: 0, recovered: null, ...d }; },
    runLevel: async (level, target) => calls.push(`runLevel:${level}:${target.id}:${target.port}`),
    recordAttempt: (s, t) => { calls.push('recordAttempt'); s.lastRestart = t; s.restartAttempts = (s.restartAttempts || 0) + 1; },
    readAutoRestart: () => ({ enabled: true }), hub: true, uid: 501, logDir: '/tmp/logs',
    killPort: killPort || (async (p) => calls.push(`killPort:${p}`)), exec: exec || (async (cmd) => calls.push(`exec:${cmd}`)), bootoutCmd: (u, l) => `bootout ${u} ${l}`, startCmd: () => 'start',
    spawn: () => {}, openLog: () => 0, exists: () => true, broadcast: (e) => calls.push(`sse:${e.type}:${e.id}:${e.status}${e.disabled === undefined ? '' : ':' + e.disabled}`),
    log: () => {}, warn: () => {}, dbg: () => {}, now: () => 1000,
  });
  return { m, calls, states };
}
const APP = { id: 'a', localUrl: 'http://localhost:4000', launchAgent: 'com.t.a', launchAgentPath: '/tmp/a.plist', localPath: '/srv/a' };

test('a breaker trip frees the port, boots out, then disables with reason breaker and alerts', async () => {
  const { m, calls } = boot({ apps: [{ ...APP }], decision: { trip: { flaps: 3, attempts: 2 } } });
  assert.equal(await m.checkAll(), true);
  assert.deepEqual(calls, ['killPort:4000', 'exec:bootout 501 com.t.a', 'disable:a:true:breaker', 'sse:update:a:down:true', 'sse:alert:a:undefined:true']);
});

test('a re-arm re-enables the app and broadcasts, then the level still runs', async () => {
  const app = { ...APP, disabled: true };
  const { m, calls } = boot({ apps: [app], decision: { rearm: 'observed up', status: 'up', level: 1 } });
  await m.checkAll();
  assert.equal(app.disabled, false);
  assert.deepEqual(calls.slice(0, 2), ['disable:a:false:', 'sse:update:a:up:false']);
  assert.ok(calls.includes('runLevel:1:a:4000'));
});

test('a level records the attempt before running it, and a transition broadcasts update + alert', async () => {
  const { m, calls, states } = boot({ apps: [{ ...APP }], decision: { changed: true, level: 2 } });
  await m.checkAll();
  assert.deepEqual(calls, ['sse:update:a:down', 'sse:alert:a:undefined', 'recordAttempt', 'runLevel:2:a:4000']);
  assert.equal(states.a.restartAttempts, 1); assert.equal(states.a.lastChecked, new Date(1000).toISOString());
});

test('a second tick while the first is in flight returns without probing', async () => {
  let probes = 0, release;
  const gate = new Promise((r) => { release = r; });
  const { m } = boot({ apps: [{ ...APP }], decision: {}, probe: async () => { probes++; await gate; return true; } });
  const first = m.checkAll();
  assert.equal(await m.checkAll(), false, 'skipped');
  release(); assert.equal(await first, true);
  assert.equal(probes, 1);
  assert.equal(await m.checkAll(), true, 'runs again once the first tick finished');
});

test('one app whose level throws does not abort the tick for the others', async () => {
  const B = { ...APP, id: 'b', localUrl: 'http://localhost:4001' };
  const { m, calls } = boot({ apps: [{ ...APP }, B], decision: { level: 1 } });
  const orig = calls.push.bind(calls);
  calls.push = (x) => { orig(x); if (x === 'runLevel:1:a:4000') throw new Error('boom'); return calls.length; };
  assert.equal(await m.checkAll(), true);
  assert.ok(calls.includes('runLevel:1:a:4000') && calls.includes('runLevel:1:b:4001'));
});

test('a throwing getApps or a rejecting probe rejects the tick but releases the guard, so the next tick runs', async () => {
  let n = 0;
  const a = boot({ apps: [{ ...APP }], decision: {}, getApps: () => { if (n++ === 0) throw new Error('SQLITE_BUSY'); return [{ ...APP }]; } });
  await assert.rejects(a.m.checkAll(), /SQLITE_BUSY/);
  assert.equal(await a.m.checkAll(), true, 'guard released after the failure');
  let p = 0;
  const b = boot({ apps: [{ ...APP }], decision: {}, probe: async () => { if (p++ === 0) throw new Error('probe died'); return true; } });
  await assert.rejects(b.m.checkAll(), /probe died/);
  assert.equal(await b.m.checkAll(), true);
});

test('a breaker trip still boots out and disables when freeing the port throws, and still disables when the bootout throws', async () => {
  const a = boot({ apps: [{ ...APP }], decision: { trip: { flaps: 3, attempts: 2 } }, killPort: async () => { throw new Error('lsof hiccup'); } });
  assert.equal(await a.m.checkAll(), true);
  assert.ok(a.calls.includes('exec:bootout 501 com.t.a'), 'bootout still attempted: ' + a.calls.join());
  assert.ok(a.calls.includes('disable:a:true:breaker')); assert.ok(a.calls.includes('sse:alert:a:undefined:true'));
  const b = boot({ apps: [{ ...APP }], decision: { trip: { flaps: 3, attempts: 2 } }, exec: async () => { throw new Error('bootout failed'); } });
  assert.equal(await b.m.checkAll(), true);
  assert.ok(b.calls.includes('killPort:4000')); assert.ok(b.calls.includes('disable:a:true:breaker'), b.calls.join());
});

test('guardedTick turns a rejecting tick into a warning and never an unhandled rejection', async () => {
  const warned = []; let unhandled = 0;
  const onUnhandled = () => { unhandled++; }; process.on('unhandledRejection', onUnhandled);
  try {
    const tick = guardedTick(async () => { throw new Error('SQLITE_BUSY'); }, (m) => warned.push(m));
    tick(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    assert.deepEqual(warned, ['  checkAll failed: SQLITE_BUSY']); assert.equal(unhandled, 0);
    const ok = guardedTick(async () => true, (m) => warned.push(m)); await ok();
    assert.equal(warned.length, 1, 'a clean tick warns nothing');
  } finally { process.off('unhandledRejection', onUnhandled); }
});
