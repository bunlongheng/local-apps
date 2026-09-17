// Unit: lib/chain.js - what each escalation level actually runs, with every side effect faked.
const { test } = require('node:test');
const assert = require('node:assert');
const { runLevel } = require('../../lib/chain');
const { startCmd, bootoutCmd } = require('../../launchctl-cmds');

function fakeDeps(logTail = '') {
  const calls = [];
  return { calls, deps: {
    exec: async (cmd) => { calls.push(cmd); return { stdout: cmd.startsWith('tail') ? logTail : '' }; },
    killPort: async (p) => { calls.push(`killPort:${p}`); }, exists: () => true, log: () => {}, warn: () => {}, startCmd, bootoutCmd,
  } };
}
const APP = { id: 'x', uid: 501, label: 'com.example.x', plistPath: '/tmp/x.plist', port: 4000, dir: '/tmp/x', logPath: '/tmp/x.log' };

test('L1 only kickstarts', async () => {
  const { calls, deps } = fakeDeps(); await runLevel(1, APP, deps);
  assert.deepEqual(calls, [startCmd(501, 'com.example.x', '/tmp/x.plist')]);
});

test('L2 frees the port, then bootout + bootstrap', async () => {
  const { calls, deps } = fakeDeps(); await runLevel(2, APP, deps);
  assert.equal(calls[0], 'killPort:4000');
  assert.match(calls[1], /^launchctl bootout gui\/501\/com\.example\.x .*; sleep 1; launchctl bootstrap gui\/501 "\/tmp\/x\.plist"/);
  assert.equal(calls.length, 2);
});

test('L3 reads the log, runs only the fixes it indicates, frees the port, restarts', async () => {
  const { calls, deps } = fakeDeps('Error: Cannot find module x'); await runLevel(3, APP, deps);
  assert.match(calls[0], /^tail -30 "\/tmp\/x\.log"/);
  assert.match(calls[1], /^cd "\/tmp\/x" && npm install --ignore-scripts/);
  assert.equal(calls[2], 'killPort:4000');
  assert.equal(calls[3], startCmd(501, 'com.example.x', '/tmp/x.plist'));
  assert.equal(calls.length, 4, 'no rm -rf .next when the log does not say so');
  const clean = fakeDeps('all good'); await runLevel(3, APP, clean.deps);
  assert.deepEqual(clean.calls.slice(1), ['killPort:4000', startCmd(501, 'com.example.x', '/tmp/x.plist')]);
});

test('L3 without a local dir skips the fixes and just restarts', async () => {
  const { calls, deps } = fakeDeps(); await runLevel(3, { ...APP, dir: null }, deps);
  assert.deepEqual(calls, [startCmd(501, 'com.example.x', '/tmp/x.plist')]);
});
