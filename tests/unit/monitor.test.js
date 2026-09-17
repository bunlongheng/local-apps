// Unit: lib/monitor.js - the tick executes what lib/tick.js decides: trip, re-arm, level, guard.
const { test } = require('node:test');
const assert = require('node:assert');
const makeMonitor = require('../../lib/monitor');

function boot({ apps, decision, probe }) {
  const calls = [], states = {};
  const m = makeMonitor({
    getApps: () => apps, setAppDisabled: (id, v, why) => calls.push(`disable:${id}:${v}:${why || ''}`),
    probe: probe || (async () => false), getState: (id) => (states[id] ||= { status: 'unknown' }),
    decide: ({ s }) => { const d = typeof decision === 'function' ? decision(s) : decision; return { status: 'down', changed: false, rearm: null, trip: null, level: 0, recovered: null, ...d }; },
    runLevel: async (level, target) => calls.push(`runLevel:${level}:${target.id}:${target.port}`),
    recordAttempt: (s, t) => { calls.push('recordAttempt'); s.lastRestart = t; s.restartAttempts = (s.restartAttempts || 0) + 1; },
    readAutoRestart: () => ({ enabled: true }), hub: true, uid: 501, logDir: '/tmp/logs',
    killPort: async (p) => calls.push(`killPort:${p}`), exec: async (cmd) => calls.push(`exec:${cmd}`), bootoutCmd: (u, l) => `bootout ${u} ${l}`, startCmd: () => 'start',
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
