// Unit: lib/breaker.js - circuit-breaker trip + re-arm policy (pure).
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldTrip, rearmReason, CHAIN_ATTEMPTS, EXHAUST_GRACE_MS, REARM_MS } = require('../../lib/breaker');

const NOW = 1_800_000_000_000;

test('does not trip while the L1-L4 chain is still running', () => {
  for (let attempts = 0; attempts < CHAIN_ATTEMPTS; attempts++) {
    const s = { restartAttempts: attempts, lastRestart: NOW - 10 * 60000, flapWindow: [] };
    assert.equal(shouldTrip(s, NOW), false, `attempt ${attempts} must reach the next level, not the breaker`);
  }
});

test('trips once the chain is exhausted and the grace period passed', () => {
  const s = { restartAttempts: CHAIN_ATTEMPTS, lastRestart: NOW - EXHAUST_GRACE_MS - 1 };
  assert.equal(shouldTrip(s, NOW), true);
  const fresh = { restartAttempts: CHAIN_ATTEMPTS, lastRestart: NOW - 1000 };
  assert.equal(shouldTrip(fresh, NOW), false, 'last attempt still within grace');
});

test('trips on 3 flaps in 2 min and prunes stale flaps', () => {
  const s = { flapWindow: [NOW - 1000, NOW - 2000, NOW - 3000] };
  assert.equal(shouldTrip(s, NOW), true);
  const stale = { flapWindow: [NOW - 130000, NOW - 1000, NOW - 2000] };
  assert.equal(shouldTrip(stale, NOW), false);
  assert.equal(stale.flapWindow.length, 2, 'stale flap pruned');
});

test('re-arm: breaker OFF observed up, or after cooldown; never a user OFF', () => {
  const at = new Date(NOW - 1000).toISOString();
  assert.equal(rearmReason({ disabled: true, disabledReason: 'breaker', disabledAt: at }, true, NOW), 'observed up');
  assert.equal(rearmReason({ disabled: true, disabledReason: 'breaker', disabledAt: at }, false, NOW), null);
  const old = new Date(NOW - REARM_MS - 1).toISOString();
  assert.equal(rearmReason({ disabled: true, disabledReason: 'breaker', disabledAt: old }, false, NOW), 'cooldown elapsed');
  assert.equal(rearmReason({ disabled: true, disabledReason: 'user', disabledAt: old }, true, NOW), null);
  assert.equal(rearmReason({ disabled: false, disabledReason: 'breaker', disabledAt: old }, true, NOW), null);
});
