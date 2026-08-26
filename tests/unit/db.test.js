// Unit: db.js - real behavioral tests against an isolated temp database.
// db.js now honours LOCAL_APPS_DB, so we point it at a throwaway file, require the module
// (schema + migrations run against the temp DB, never the live local.db), and exercise the
// real query layer end to end.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `local-apps-test-${process.pid}.db`);
process.env.LOCAL_APPS_DB = TMP_DB;
const db = require('../../db');

after(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch {}
  }
});

test('upsertApp inserts, getApp reads back with camelCase mapping', () => {
  db.upsertApp({ id: 'zzz-test-app', name: 'ZZZ', localUrl: 'http://localhost:4321', repo: 'x/y' });
  const a = db.getApp('zzz-test-app');
  assert.equal(a.id, 'zzz-test-app');
  assert.equal(a.name, 'ZZZ');
  assert.equal(a.localUrl, 'http://localhost:4321'); // snake_case local_url -> camelCase
  assert.equal(a.repo, 'x/y');
});

test('upsertApp updates an existing row without duplicating it', () => {
  const before = db.getApps().length;
  db.upsertApp({ id: 'zzz-test-app', name: 'ZZZ-renamed' });
  assert.equal(db.getApps().length, before);
  assert.equal(db.getApp('zzz-test-app').name, 'ZZZ-renamed');
});

test('setAppDisabled toggles the disabled flag', () => {
  db.setAppDisabled('zzz-test-app', true);
  assert.equal(db.getApp('zzz-test-app').disabled, true);
  db.setAppDisabled('zzz-test-app', false);
  assert.equal(db.getApp('zzz-test-app').disabled, false);
});

test('upsertApp REJECTS a launchAgent with shell metacharacters (RCE backstop)', () => {
  assert.throws(() => db.upsertApp({ id: 'zzz-evil', launchAgent: 'x; touch /tmp/pwned; #' }), /unsafe launchAgent/);
  assert.throws(() => db.upsertApp({ id: 'zzz-evil', launchAgentPath: '/tmp/a";evil' }), /unsafe launchAgentPath/);
  // a legitimate derived label + plist path is accepted
  assert.doesNotThrow(() => db.upsertApp({ id: 'zzz-ok', launchAgent: 'com.bheng.zzz-ok', launchAgentPath: '/Users/bheng/Library/LaunchAgents/com.bheng.zzz-ok.plist' }));
  db.deleteApp('zzz-ok');
});

test('syncRemoteApps stores then getRemoteApps reads a machine\'s apps', () => {
  db.upsertMachine({ id: 'peer1', hostname: 'peer1', ip: '10.0.0.50', port: 9875, model: 'Mac' });
  db.syncRemoteApps('peer1', [{ id: 'r1', name: 'Remote One', localUrl: 'http://localhost:3001' }]);
  const remote = db.getRemoteApps().filter(r => r.machine_id === 'peer1');
  assert.equal(remote.length, 1);
  assert.equal(remote[0].id, 'r1');
  // re-sync replaces cleanly (no duplicates)
  db.syncRemoteApps('peer1', [{ id: 'r1', name: 'Remote One', localUrl: 'http://localhost:3001' }]);
  assert.equal(db.getRemoteApps().filter(r => r.machine_id === 'peer1').length, 1);
});

test('deleteApp removes the row', () => {
  db.deleteApp('zzz-test-app');
  assert.equal(db.getApp('zzz-test-app'), undefined);
});
