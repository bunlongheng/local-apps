// Unit: lib/escalation.js - the L1-L4 selection rules, pure and clock-driven.
const { test } = require('node:test');
const assert = require('node:assert');
const { nextLevel, recordAttempt, l3Fixes, RETRY_MS, L2_AFTER_MS, L3_AFTER_MS, L4_AFTER_MS, L4_RETRY_MS } = require('../../lib/escalation');
const T0 = 1_800_000_000_000;

test('L1 fires on the first attempt and once more after the retry window', () => {
  assert.equal(nextLevel({ downSince: T0 }, T0), 1);
  const s = { downSince: T0 }; recordAttempt(s, T0);
  assert.equal(nextLevel(s, T0 + 10_000), 0, 'not before 60s');
  assert.equal(nextLevel(s, T0 + RETRY_MS + 1), 1, '1 retry of L1');
});

test('L2 needs 2 attempts spent, 90s down, and 60s since the last try', () => {
  const s = { downSince: T0, restartAttempts: 2, lastRestart: T0 + 60_000 };
  assert.equal(nextLevel(s, T0 + 80_000), 0, 'too early: 80s down');
  assert.equal(nextLevel(s, T0 + L2_AFTER_MS + 1), 0, 'too soon since the last restart');
  assert.equal(nextLevel(s, T0 + 60_000 + RETRY_MS + 1), 2);
});

test('L3 and L4 gates, then nothing until the breaker', () => {
  assert.equal(nextLevel({ downSince: T0, restartAttempts: 3, lastRestart: T0 }, T0 + L3_AFTER_MS + 1), 3);
  assert.equal(nextLevel({ downSince: T0, restartAttempts: 4, lastRestart: T0 }, T0 + L4_AFTER_MS + 1), 4);
  assert.equal(nextLevel({ downSince: T0, restartAttempts: 4, lastRestart: T0 + L4_AFTER_MS }, T0 + L4_AFTER_MS + L4_RETRY_MS - 1), 0, 'L4 waits 120s between tries');
  assert.equal(nextLevel({ downSince: T0, restartAttempts: 5, lastRestart: T0 }, T0 + 10 * L4_AFTER_MS), 0, 'chain exhausted');
});

test('recordAttempt counts even when the command will fail', () => {
  const s = {}; recordAttempt(s, T0); recordAttempt(s, T0 + 1);
  assert.deepEqual(s, { lastRestart: T0 + 1, restartAttempts: 2 });
});

test('L3 picks fixes from the log tail', () => {
  assert.deepEqual(l3Fixes('Error: Cannot find module x'), { npmInstall: true, clearNext: false });
  assert.deepEqual(l3Fixes('.next/BUILD_ID ENOENT'), { npmInstall: false, clearNext: true });
  assert.deepEqual(l3Fixes(''), { npmInstall: false, clearNext: false });
});
