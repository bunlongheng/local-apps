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
  const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  // `kickstart` without -k (cron run-now) is fine; `kickstart -k` is the app
  // restart pattern and must always carry the bootstrap fallback via startCmd.
  assert.equal(src.match(/launchctl kickstart -k/g), null,
    'found an inline `launchctl kickstart -k` in server.js - use startCmd() from launchctl-cmds.js so the bootstrap fallback is never lost');
  assert.ok(src.includes("require('./launchctl-cmds')"), 'server.js must import startCmd');
  const calls = src.match(/startCmd\(/g);
  assert.ok(calls, 'expected startCmd() calls in server.js, found none');
  assert.ok(calls.length >= 6,
    `expected startCmd() at the 6 start sites (toggle-ON, bulk-toggle, /api/start, auto-restart L1/L3, L4 agent prompt), found ${calls.length}`);
});
