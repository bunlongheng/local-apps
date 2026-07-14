// Unit: launchctl start command contract. Regression guard for the bug where
// toggle-ON / /api/start / auto-restart L1 ran a bare `launchctl kickstart`,
// which exits 113 on services booted out of launchd (post LaunchAgent purge)
// and left enabled apps stuck yellow. Every start path must fall back to
// bootstrapping the plist.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startCmd } = require('../../launchctl-cmds');

const UID = 501;
const LABEL = 'com.example.claude';
const PLIST = '/Users/me/Library/LaunchAgents/com.example.claude.plist';
const cmd = startCmd(UID, LABEL, PLIST);

test('startCmd tries kickstart on the gui domain service first', () => {
  assert.ok(cmd.startsWith(`launchctl kickstart -k gui/${UID}/${LABEL}`));
});

test('startCmd falls back to bootstrap when kickstart fails', () => {
  const [first, second] = cmd.split('||').map(s => s.trim());
  assert.match(first, /^launchctl kickstart /, 'kickstart must run first (restart if loaded)');
  assert.equal(second, `launchctl bootstrap gui/${UID} "${PLIST}" 2>/dev/null`);
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
