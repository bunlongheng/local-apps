// Unit: launchctl start command contract. Regression guard for two bugs that
// both left enabled apps stuck yellow forever:
//   1. a bare `launchctl kickstart`, which exits 113 on services booted out of
//      launchd (post LaunchAgent purge) - fixed by the bootstrap fallback.
//   2. a bootstrap fallback that cannot load a `launchctl disable`d label
//      ("Bootstrap failed: 5: Input/output error") and, for RunAtLoad=false
//      plists, would not have started the process even if it had loaded.
// Every start path must enable, bootstrap, then kickstart on the fallback.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startCmd, bootoutCmd } = require('../../launchctl-cmds');

const UID = 501;
const LABEL = 'com.example.claude';
const PLIST = '/Users/YOU/Library/LaunchAgents/com.example.claude.plist';
const cmd = startCmd(UID, LABEL, PLIST);

test('startCmd tries kickstart on the gui domain service first', () => {
  assert.ok(cmd.startsWith(`launchctl kickstart -k gui/${UID}/${LABEL}`));
});

test('startCmd falls back to enable + bootstrap + kickstart when kickstart fails', () => {
  const [first, second] = cmd.split('||').map(s => s.trim());
  assert.match(first, /^launchctl kickstart /, 'kickstart must run first (restart if loaded)');

  const steps = second.replace(/^\{\s*|\s*\}$/g, '').split(';').map(s => s.trim()).filter(Boolean);
  assert.deepEqual(steps, [
    `launchctl enable gui/${UID}/${LABEL} 2>/dev/null`,
    `launchctl bootstrap gui/${UID} "${PLIST}" 2>/dev/null`,
    `launchctl kickstart gui/${UID}/${LABEL} 2>/dev/null`,
  ], 'fallback must enable the label (a disabled one cannot bootstrap), load it, then start it');
});

test('startCmd enables before bootstrapping - order matters', () => {
  assert.ok(cmd.indexOf('launchctl enable') < cmd.indexOf('launchctl bootstrap'),
    'bootstrap on a disabled label fails with "Bootstrap failed: 5: Input/output error"');
});

test('startCmd kickstarts after bootstrap (RunAtLoad=false plists never self-start)', () => {
  const fallback = cmd.split('||')[1];
  assert.ok(fallback.indexOf('launchctl bootstrap') < fallback.lastIndexOf('launchctl kickstart'),
    'bootstrap only loads the job; a trailing kickstart is what starts the process');
});

test('startCmd quotes the plist path (paths can contain spaces)', () => {
  const spaced = startCmd(UID, LABEL, '/Users/b h/Library/LaunchAgents/x.plist');
  assert.ok(spaced.includes('"/Users/b h/Library/LaunchAgents/x.plist"'));
});

test('startCmd silences stderr on both branches (callers rely on exit codes)', () => {
  for (const part of cmd.split('||')) {
    assert.match(part, /2>\/dev\/null/);
  }
});

// The 'no inline launchctl kickstart -k' rule is enforced by eslint (no-restricted-syntax in the
// eslint config); start behaviour is asserted through ctx.startCmd in routes-apps and chain tests.

test('killPort frees a real listener without a shell and resolves 0 on a free port', async () => {
  const { killPort } = require('../../launchctl-cmds');
  const net = require('node:net');
  const srv = net.createServer().listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;
  assert.equal(await killPort(0), 0, 'no port, nothing to do');

  // Our own process holds the port; killing it would end the test runner, so only assert
  // that lsof sees exactly this listener and that the pipeline is shell-free.
  const { execFileSync } = require('node:child_process');
  assert.equal(String(execFileSync('lsof', ['-ti', `:${port}`])).trim(), String(process.pid));
  // The free-port branch is asserted on the port this test just owned and released: never a
  // fixed number that something else on the host may be listening on.
  const released = port; await new Promise(r => srv.close(r));
  assert.equal(await killPort(released), 0, 'a just-released port kills nothing');
});

test('killPort actually kills a child holding the port', async () => {
  const { killPort } = require('../../launchctl-cmds');
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port))});setInterval(()=>{},1000)"]);
  const port = await new Promise(r => child.stdout.once('data', d => r(Number(String(d)))));
  const exited = new Promise(r => child.once('exit', r));
  assert.equal(await killPort(port), 1, '1 pid killed');
  await exited;
  assert.equal(child.exitCode === null ? child.signalCode : child.exitCode, 'SIGKILL');
});

test('bootoutCmd unloads exactly the labelled service for the uid, stderr silenced, no other shell tokens', () => {
  assert.equal(bootoutCmd(501, 'com.example.x'), 'launchctl bootout gui/501/com.example.x 2>/dev/null');
  assert.ok(!/[;&|`$]/.test(bootoutCmd(501, 'com.example.x').replace('2>/dev/null', '')), 'no chaining operators');
});
