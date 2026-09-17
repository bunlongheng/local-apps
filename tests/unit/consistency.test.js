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
const TMP_DIRS = [];
after(() => { for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TMP_DB + s); } catch { /* not created */ } } for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); });

test('audit lists every app in the db with a misses array', () => {
  db.upsertApp({ id: 'zzz-cons', localPath: '/tmp/zzz-cons', launchAgentPath: '/tmp/definitely-missing.plist' });
  const report = audit();
  const row = report.find(r => r.id === 'zzz-cons');
  assert.ok(row, 'app from db.js is audited');
  assert.ok(Array.isArray(row.misses));
  assert.ok(row.misses.includes('launch-agent'), 'plist path from the row is checked, and it does not exist');
});

test('launch-agent passes when the row plist exists, whatever its label prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cons2-')); TMP_DIRS.push(dir);
  const plist = path.join(dir, 'com.someone.zzz-cons2.plist');
  fs.writeFileSync(plist, '<plist/>');
  db.upsertApp({ id: 'zzz-cons2', localPath: '/tmp/zzz-cons2', launchAgentPath: plist });
  const { checks } = checkApp('zzz-cons2');
  assert.equal(checks.find(([k]) => k === 'launch-agent')[1], true);
});

test('all 10 artifact rules pass on a fully wired fixture and removing artifacts one by one grows the miss set by exactly that rule', () => {
  const { P } = require('../../scripts/consistency');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cons-')); TMP_DIRS.push(home);
  const id = 'zzz-wired';
  const mk = (rel, body) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const plist = mk('LaunchAgents/com.t.zzz-wired.plist', '<plist/>');
  Object.assign(P, {
    favDir: path.dirname(mk('favicons/zzz-wired.png', 'png')), saiDir: path.dirname(mk('app-icons/zzz-wired.png', 'png')),
    reg: mk('app-icons.ts', `export const ICONS = { "${id}": "zzz-wired.png" };`),
    colors: mk('tab-colors.json', JSON.stringify({ [id]: { label: 'W', r: 1, g: 2, b: 3 } })),
    tabsh: mk('claude-tabs.sh', '_tab_defs() { :; }\n'),
    caddy: mk('Caddyfile', `${id}.localhost {\n  reverse_proxy localhost:4000\n}\n`),
  });
  db.upsertApp({ id, localPath: path.join(home, 'repo'), launchAgentPath: plist, about: 'About', features: ['f1'], repo: 'https://github.com/x/y', prodUrl: 'https://y.example.com' });
  const ok = checkApp(id);
  assert.deepEqual(ok.checks.map(([k]) => k), ['favicon', 'stickies-icon', 'stickies-reg', 'tab-color', 'tab-alias', 'caddy-host', 'launch-agent', 'profile', 'repo', 'prod-url']);
  assert.deepEqual(ok.checks.filter(([, v]) => !v), [], 'fully wired: no misses');
  assert.equal(audit(id)[0].ok, true);
  // Knock each artifact out in turn and expect exactly that rule to miss.
  const knock = {
    'favicon': () => fs.unlinkSync(path.join(P.favDir, 'zzz-wired.png')), 'stickies-icon': () => fs.unlinkSync(path.join(P.saiDir, 'zzz-wired.png')),
    'stickies-reg': () => fs.writeFileSync(P.reg, 'export const ICONS = {};'), 'tab-color': () => fs.writeFileSync(P.colors, '{}'),
    'caddy-host': () => fs.writeFileSync(P.caddy, ''), 'launch-agent': () => fs.unlinkSync(plist),
    'profile': () => db.upsertApp({ id, about: '' }), 'repo': () => db.upsertApp({ id, repo: '' }),
  };
  const expected = [];
  for (const [rule, fn] of Object.entries(knock)) {
    fn(); expected.push(rule);
    if (rule === 'tab-color') expected.push('tab-alias');   // by design: the alias is generated from registry membership, so losing the colour loses the alias
    assert.deepEqual(audit(id)[0].misses.slice().sort(), expected.slice().sort(), `after removing ${rule} exactly these rules miss`);
  }
  // tab-alias: a hand-written shortcut alias is drift even when the generator exists.
  fs.writeFileSync(P.colors, JSON.stringify({ [id]: { r: 1, g: 2, b: 3 } })); fs.writeFileSync(P.tabsh, `_tab_defs() { :; }\n_zw() { _tab "${id}"; }\n`);
  const r = audit(id)[0]; assert.ok(r.misses.includes('tab-alias')); assert.match(r.note, /shortcut alias _zw/);
  // prod-url: only a Vercel app must carry one.
  fs.mkdirSync(path.join(home, 'repo', '.vercel'), { recursive: true }); fs.writeFileSync(path.join(home, 'repo', '.vercel', 'project.json'), '{}');
  db.upsertApp({ id, prodUrl: '' });
  assert.ok(audit(id)[0].misses.includes('prod-url'));
});
