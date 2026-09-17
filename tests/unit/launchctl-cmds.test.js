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
const { startCmd } = require('../../launchctl-cmds');

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

test('server.js has no bare app restart (kickstart -k) - all start paths use startCmd', () => {
  // Routes live in routes/*.js since the split; the rule covers every file that can start an app.
  const files = ['server.js', 'lib/chain.js', 'routes/apps.js', 'routes/meta.js', 'routes/machines.js'];
  const src = files.map(f => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8')).join('\n');
  // `kickstart` without -k (cron run-now) is fine; `kickstart -k` is the app
  // restart pattern and must always carry the bootstrap fallback via startCmd.
  assert.equal(src.match(/launchctl kickstart -k/g), null,
    'found an inline `launchctl kickstart -k` - use startCmd() from launchctl-cmds.js so the bootstrap fallback is never lost');
  assert.ok(src.includes("require('./launchctl-cmds')"), 'startCmd must be imported from launchctl-cmds');
  const calls = src.match(/startCmd\(/g);
  assert.ok(calls, 'expected startCmd() calls, found none');
  assert.ok(calls.length >= 6,
    `expected startCmd() at the 6 start sites (toggle-ON, bulk-toggle, /api/start, auto-restart L1/L3, L4 agent prompt), found ${calls.length}`);
});

test('killPort frees a real listener without a shell and resolves 0 on a free port', async () => {
  const { killPort } = require('../../launchctl-cmds');
  const net = require('node:net');
  const srv = net.createServer().listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;
  assert.equal(await killPort(0), 0, 'no port, nothing to do');
  const free = await killPort(59997); assert.equal(free, 0, 'a free port kills nothing');
  // Our own process holds the port; killing it would end the test runner, so only assert
  // that lsof sees exactly this listener and that the pipeline is shell-free.
  const { execFileSync } = require('node:child_process');
  assert.equal(String(execFileSync('lsof', ['-ti', `:${port}`])).trim(), String(process.pid));
  srv.close();
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
