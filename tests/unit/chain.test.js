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

test('L4 spawns the agent with argv (no shell) and an allowlist, only when opted in', async () => {
  const spawned = [];
  const { deps } = fakeDeps();
  const l4 = { ...deps, spawn: (bin, args, opts) => { spawned.push({ bin, args, opts }); return { unref() {} }; }, openLog: () => 7, agent: true };
  await runLevel(4, { ...APP, downMs: 300000 }, l4);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].bin, 'claude');
  assert.equal(spawned[0].args[0], '-p');
  assert.match(spawned[0].args[1], /down for 5 minutes/);
  assert.ok(!spawned[0].args.includes('--dangerously-skip-permissions'));
  const allowed = spawned[0].args[spawned[0].args.indexOf('--allowedTools') + 1];
  assert.ok(!/:\*/.test(allowed), 'no prefix wildcards: ' + allowed);
  assert.ok(allowed.includes('Bash(tail -50 /tmp/x.log)') && allowed.includes('Bash(curl -s http://localhost:4000*)'));
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--max-turns') + 1], '25');
  assert.equal(spawned[0].opts.cwd, '/tmp/x');
  assert.deepEqual(spawned[0].opts.stdio, ['ignore', 7, 7]);
  const off = { ...l4, agent: false };
  await runLevel(4, APP, off);
  assert.equal(spawned.length, 1, 'no spawn when the agent is not opted in');
});
