// Unit: lib/tick.js - the per-app decision checkAll executes each tick.
const { test } = require('node:test');
const assert = require('node:assert');
const { decide } = require('../../lib/tick');
const { recordAttempt, L2_AFTER_MS, RETRY_MS } = require('../../lib/escalation');
const { REARM_MS } = require('../../lib/breaker');

const T0 = 1_700_000_000_000;
const APP = { id: 'x', launchAgent: 'com.example.x', launchAgentPath: '/tmp/x.plist' };
const hub = { hub: true, autoRestart: true };

test('up -> down is a transition that fires L1 on the hub', () => {
  const s = { status: 'up' };
  const d = decide({ s, app: APP, up: false, now: T0, ...hub });
  assert.equal(d.changed, true); assert.equal(d.status, 'down'); assert.equal(d.level, 1); assert.equal(d.trip, null);
  assert.equal(s.downSince, T0);
});

test('the same status twice is not a transition', () => {
  const s = { status: 'down', downSince: T0 };
  assert.equal(decide({ s, app: APP, up: false, now: T0 + 30000, ...hub }).changed, false);
});

test('no chain on an agent machine, with auto-restart off, or without a LaunchAgent', () => {
  for (const c of [{ hub: false, autoRestart: true }, { hub: true, autoRestart: false }]) {
    const s = { status: 'up' };
    const d = decide({ s, app: APP, up: false, now: T0, ...c });
    assert.equal(d.changed, true, 'status still tracked'); assert.equal(d.level, 0); assert.equal(s.downSince, undefined);
  }
  assert.equal(decide({ s: { status: 'up' }, app: { id: 'y' }, up: false, now: T0, ...hub }).level, 0);
});

test('a user OFF is never touched: no re-arm, no level', () => {
  const s = { status: 'down' };
  const d = decide({ s, app: { ...APP, disabled: true, disabledReason: 'user' }, up: false, now: T0, ...hub });
  assert.equal(d.rearm, null); assert.equal(d.level, 0);
});

test('a breaker OFF re-arms when observed up, or after the cooldown while still down (then L1 runs again)', () => {
  const off = { ...APP, disabled: true, disabledReason: 'breaker', disabledAt: new Date(T0).toISOString() };
  let s = { status: 'down', restartAttempts: 5, flapWindow: [T0] };
  let d = decide({ s, app: off, up: true, now: T0 + 1000, ...hub });
  assert.equal(d.rearm, 'observed up'); assert.equal(d.level, 0); assert.equal(s.restartAttempts, 0);
  s = { status: 'down', restartAttempts: 5 };
  d = decide({ s, app: off, up: false, now: T0 + REARM_MS + 1, ...hub });
  assert.equal(d.rearm, 'cooldown elapsed'); assert.equal(d.level, 1, 'counters reset, chain starts over');
});

test('a crash within 2 min of a restart is a flap; an old restart is not', () => {
  const s = { status: 'up', lastRestart: T0 - 60000 };
  decide({ s, app: APP, up: false, now: T0, ...hub });
  assert.deepEqual(s.flapWindow, [T0]);
  const old = { status: 'up', lastRestart: T0 - 200000 };
  decide({ s: old, app: APP, up: false, now: T0, ...hub });
  assert.deepEqual(old.flapWindow || [], [], "no flap recorded");
});

test('3 flaps in 2 min trip the breaker instead of another level, and reset the counters', () => {
  const s = { status: 'up', lastRestart: T0 - 1000, flapWindow: [T0 - 90000, T0 - 50000], restartAttempts: 3 };
  const d = decide({ s, app: APP, up: false, now: T0, ...hub });
  assert.deepEqual(d.trip, { flaps: 3, attempts: 3 }); assert.equal(d.level, 0);
  assert.equal(s.downSince, null); assert.equal(s.restartAttempts, 0); assert.deepEqual(s.flapWindow, []);
});

test('levels escalate over time as attempts are recorded', () => {
  const s = { status: 'up' };
  let now = T0;
  assert.equal(decide({ s, app: APP, up: false, now, ...hub }).level, 1); recordAttempt(s, now);
  now += 30000; assert.equal(decide({ s, app: APP, up: false, now, ...hub }).level, 0, 'retry window not elapsed');
  now += RETRY_MS; assert.equal(decide({ s, app: APP, up: false, now, ...hub }).level, 1); recordAttempt(s, now);
  now += L2_AFTER_MS; assert.equal(decide({ s, app: APP, up: false, now, ...hub }).level, 2);
});

test('coming back up after attempts reports the recovery and clears the counters', () => {
  const s = { status: 'down', downSince: T0, restartAttempts: 2 };
  const d = decide({ s, app: APP, up: true, now: T0 + 45000, ...hub });
  assert.deepEqual(d.recovered, { attempts: 2, downMs: 45000 }); assert.equal(s.downSince, null); assert.equal(s.restartAttempts, 0);
  assert.equal(decide({ s, app: APP, up: true, now: T0 + 90000, ...hub }).recovered, null);
});
