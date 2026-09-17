// Unit: scripts/consistency.js reads the registry through db.js (so LOCAL_APPS_DB applies)
// and derives the LaunchAgent check from the app's own plist path, not an owner prefix.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TMP_DB = path.join(os.tmpdir(), `local-apps-consistency-${process.pid}.db`);
process.env.LOCAL_APPS_DB = TMP_DB;
const db = require('../../db');
const { audit, checkApp } = require('../../scripts/consistency');
after(() => { for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TMP_DB + s); } catch { /* not created */ } } });

test('audit lists every app in the db with a misses array', () => {
  db.upsertApp({ id: 'zzz-cons', localPath: '/tmp/zzz-cons', launchAgentPath: '/tmp/definitely-missing.plist' });
  const report = audit();
  const row = report.find(r => r.id === 'zzz-cons');
  assert.ok(row, 'app from db.js is audited');
  assert.ok(Array.isArray(row.misses));
  assert.ok(row.misses.includes('launch-agent'), 'plist path from the row is checked, and it does not exist');
});

test('launch-agent passes when the row plist exists, whatever its label prefix', () => {
  const plist = path.join(os.tmpdir(), `com.someone.zzz-cons2-${process.pid}.plist`);
  fs.writeFileSync(plist, '<plist/>');
  db.upsertApp({ id: 'zzz-cons2', localPath: '/tmp/zzz-cons2', launchAgentPath: plist });
  const { checks } = checkApp('zzz-cons2');
  assert.equal(checks.find(([k]) => k === 'launch-agent')[1], true);
  fs.unlinkSync(plist);
});
