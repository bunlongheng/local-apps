// Unit: db.js. IMPORTANT - db.js hardcodes:
//   const DB_PATH = path.join(__dirname, 'local.db');
//   const db = new Database(DB_PATH);
// with no env var or parameter override, and simply requiring the module runs
// schema creation, ALTER TABLE migrations, and (if the apps table is empty)
// config seeding against that path at import time. `local.db` is the real,
// live database backing the running dashboard (verified present and recently
// modified on this machine) - there is no ':memory:' or temp-path override to
// hook into, and no pure mapping helper (e.g. rowToApp) is exported for
// side-effect-free testing. Per the task spec's fallback for this exact case,
// we do NOT require('../../db') here - that would open and migrate the real
// database. Instead we statically verify the hardcoded-path shape (so this
// test breaks loudly if someone adds an override, prompting a rewrite of this
// file to exercise a real in-memory DB) and the pure, static column-mapping
// table that upsertApp uses, read directly from source text.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../../db.js'), 'utf8');

test('db.js hardcodes DB_PATH to local.db with no env/argument override', () => {
  assert.match(SRC, /const DB_PATH = path\.join\(__dirname, 'local\.db'\)/,
    'expected the known hardcoded path - if this changed, rewrite db.test.js to open a real in-memory DB');
  assert.doesNotMatch(SRC, /process\.env\.[A-Z_]*DB[A-Z_]*/,
    'no DB path env override exists - do not require(db.js) directly in tests');
  assert.match(SRC, /new Database\(DB_PATH\)/);
});

test('db.js exports the expected app CRUD surface (by name, without invoking it)', () => {
  const exportsBlock = SRC.slice(SRC.indexOf('module.exports'));
  for (const fn of ['getApps', 'getApp', 'upsertApp', 'deleteApp', 'toggleApp', 'setAppDisabled']) {
    assert.ok(exportsBlock.includes(fn), `expected ${fn} to be exported`);
  }
});

test('db.js does not export the internal rowToApp mapper (no pure helper to unit test directly)', () => {
  const exportsBlock = SRC.slice(SRC.indexOf('module.exports'));
  assert.ok(!exportsBlock.includes('rowToApp'), 'rowToApp is internal only');
  assert.match(SRC, /function rowToApp\(row\)/, 'rowToApp must still exist internally');
});

test('upsertApp camelCase -> column mapping covers the core app fields', () => {
  const mapMatch = SRC.match(/const map = \{([\s\S]*?)\};/);
  assert.ok(mapMatch, 'expected the camelCase->column map object in upsertApp');
  const mapBody = mapMatch[1];
  const expected = {
    healthUrl: 'health_url',
    localUrl: 'local_url',
    localPath: 'local_path',
    logPath: 'log_path',
    launchAgent: 'launch_agent',
    launchAgentPath: 'launch_agent_path',
    startCommand: 'start_command',
    noScreenshot: 'no_screenshot',
  };
  for (const [camel, column] of Object.entries(expected)) {
    assert.match(mapBody, new RegExp(`${camel}:\\s*'${column}'`), `${camel} must map to ${column}`);
  }
});

test('apps table schema declares id as the primary key and disabled/no_screenshot as integer flags', () => {
  assert.match(SRC, /CREATE TABLE IF NOT EXISTS apps \(\s*id TEXT PRIMARY KEY/);
  assert.match(SRC, /no_screenshot INTEGER DEFAULT 0/);
});

test('schema/migration statements are written as idempotent CREATE-IF-NOT-EXISTS / try-catch ALTERs', () => {
  // Every CREATE TABLE in the file must guard with IF NOT EXISTS, so re-running
  // db.js (e.g. across worker restarts) never throws on an existing schema.
  const createStatements = SRC.match(/CREATE TABLE[^(]*/g) || [];
  assert.ok(createStatements.length > 0, 'expected at least one CREATE TABLE statement');
  for (const stmt of createStatements) {
    assert.match(stmt, /CREATE TABLE IF NOT EXISTS/, `non-idempotent create: ${stmt}`);
  }
  // Column-add migrations rely on ALTER TABLE failing silently when the column
  // already exists, rather than checking pragma first - confirm the try/catch guard.
  const alterLines = SRC.split('\n').filter(l => l.includes('ALTER TABLE'));
  assert.ok(alterLines.length > 0, 'expected ALTER TABLE migration lines');
  for (const line of alterLines) {
    assert.ok(line.includes('try {') && line.includes('catch'), `ALTER TABLE line must be try/catch guarded: ${line}`);
  }
});
