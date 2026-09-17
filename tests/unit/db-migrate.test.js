// Unit: db.js migrations against an OLD database, not a fresh schema: the ALTER TABLE branches must
// actually run and the row must come back with every column the code reads today.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const TMP_DB = path.join(os.tmpdir(), `local-apps-migrate-${process.pid}.db`);
after(() => { for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TMP_DB + s); } catch { /* not created */ } } });

test('an old-shape database gains every migrated column and its rows read back with defaults', () => {
  const old = new Database(TMP_DB);
  old.exec(`CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT, health_url TEXT, local_url TEXT, process_check TEXT, caddy_url TEXT, prod_url TEXT, local_path TEXT, log_path TEXT, repo TEXT, launch_agent TEXT, launch_agent_path TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  old.prepare(`INSERT INTO apps (id, name, local_url) VALUES ('old', 'Old', 'http://localhost:3123')`).run();
  old.close();
  process.env.LOCAL_APPS_DB = TMP_DB;
  const db = require('../../db');
  const cols = new Set(new Database(TMP_DB, { readonly: true }).prepare('PRAGMA table_info(apps)').all().map(c => c.name));
  for (const c of ['start_command', 'icon', 'disabled', 'disabled_reason', 'disabled_at', 'tab_color', 'tab_icon', 'prod_url2', 'about', 'features', 'sort_order']) assert.ok(cols.has(c), `column ${c} added`);
  const a = db.getApp('old');
  assert.equal(a.name, 'Old'); assert.equal(a.localUrl, 'http://localhost:3123');
  assert.equal(a.startCommand, 'npm run dev'); assert.equal(a.disabled, false); assert.equal(a.prodUrl2, null); assert.equal(a.tabColor, null);
  db.upsertApp({ id: 'old', tabColor: '#123456', prodUrl2: 'https://two.example.com', features: ['x'] });
  const b = db.getApp('old');
  assert.equal(b.tabColor, '#123456'); assert.equal(b.prodUrl2, 'https://two.example.com'); assert.deepEqual(b.features, ['x']);
  db.setAppDisabled('old', true, 'breaker');
  assert.equal(db.getApp('old').disabled, true); assert.equal(db.getApp('old').disabledReason, 'breaker');
});
