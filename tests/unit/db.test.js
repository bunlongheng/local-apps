// Unit: db.js - real behavioral tests against an isolated temp database.
// db.js now honours LOCAL_APPS_DB, so we point it at a throwaway file, require the module
// (schema + migrations run against the temp DB, never the live local.db), and exercise the
// real query layer end to end.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `local-apps-test-${process.pid}.db`);
process.env.LOCAL_APPS_DB = TMP_DB;
const db = require('../../db');

after(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* not created */ }
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
  assert.doesNotThrow(() => db.upsertApp({ id: 'zzz-ok', launchAgent: 'com.bheng.zzz-ok', launchAgentPath: '/Users/YOU/Library/LaunchAgents/com.bheng.zzz-ok.plist' }));
  db.deleteApp('zzz-ok');
});

test('syncRemoteApps stores then getRemoteApps reads a machine\'s apps', () => {
  db.upsertMachine({ id: 'peer1', hostname: 'peer1', ip: '1.2.3.4', port: 9875, model: 'Mac' });
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

test('setAppDisabled records who turned it off and when; enabling clears both', () => {
  db.upsertApp({ id: 'zzz-breaker', name: 'B' });
  db.setAppDisabled('zzz-breaker', true, 'breaker');
  let a = db.getApp('zzz-breaker');
  assert.equal(a.disabled, true);
  assert.equal(a.disabledReason, 'breaker');
  assert.ok(!Number.isNaN(Date.parse(a.disabledAt)), 'disabledAt is an ISO timestamp');
  db.setAppDisabled('zzz-breaker', true);
  assert.equal(db.getApp('zzz-breaker').disabledReason, 'user', 'default reason is user');
  db.setAppDisabled('zzz-breaker', false);
  a = db.getApp('zzz-breaker');
  assert.equal(a.disabled, false);
  assert.equal(a.disabledReason, null);
  assert.equal(a.disabledAt, null);
  db.deleteApp('zzz-breaker');
});

test('upsertApp keeps profile fields on create, not only on update', () => {
  const a = db.upsertApp({ id: 'zzz-prof-create', localPath: '/tmp/zzz', about: 'first', features: ['a', 'b'], sortOrder: 3 });
  assert.equal(a.about, 'first');
  assert.deepEqual(a.features, ['a', 'b']);
  assert.equal(a.sortOrder, 3);
});

test('machines and remote apps: upsert, list, delete', () => {
  db.upsertMachine({ id: 'peer-t', hostname: 'peer-t', ip: '1.2.3.4', port: 9875, model: 'Mac' });
  assert.ok(db.getMachines().some(m => m.id === 'peer-t'));
  db.syncRemoteApps('peer-t', [{ id: 'ra', name: 'RA', localUrl: 'http://localhost:1', status: 'up' }, { id: '../x' }]);
  assert.deepEqual(db.getRemoteApps('peer-t').map(r => r.id), ['ra'], 'the invalid record was dropped by the sanitiser');
  db.deleteRemoteApps('peer-t'); db.deleteMachine('peer-t');
  assert.equal(db.getRemoteApps('peer-t').length, 0); assert.ok(!db.getMachines().some(m => m.id === 'peer-t'));
});

test('upsertApp keeps prodUrl2, tabColor and tabIcon on create', () => {
  const a = db.upsertApp({ id: 'zzz-extra', localPath: '/tmp/zzz', prodUrl2: 'https://x.example', tabColor: '#123456', tabIcon: 'X' });
  assert.equal(a.prodUrl2, 'https://x.example'); assert.equal(a.tabColor, '#123456'); assert.equal(a.tabIcon, 'X');
});
