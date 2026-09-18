// Require server.js the way the route suites must: with every child_process function and every
// fs write API spied at import, so a top-level shell-out or a write anywhere but the scratch home
// (not even elsewhere under os.tmpdir()) fails loudly. Returns the app. Used by routes-security
// and routes-notoken.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { mock } = require('node:test');

module.exports = function requireHermetic(scratchHome) {
  assert.equal(require.cache[require.resolve('../../../server')], undefined, 'server must not be preloaded: this file needs its own process');
  const shell = ['execSync', 'exec', 'execFile', 'spawn', 'spawnSync'].map((f) => mock.method(cp, f));
  // Sync, callback and promise forms: a call is recorded at import even when its I/O completes later.
  const BASE = ['mkdir', 'writeFile', 'appendFile', 'copyFile', 'rename', 'rm', 'rmdir', 'unlink', 'open'];
  const WRITE_APIS = [...BASE.map((f) => f + 'Sync'), ...BASE, 'createWriteStream'];
  const writes = WRITE_APIS.map((f) => mock.method(fs, f));
  const promised = BASE.map((f) => mock.method(fs.promises, f));
  const app = require('../../../server');
  for (const sp of shell) assert.equal(sp.mock.callCount(), 0, 'importing server.js must not shell out');
  const readOnlyOpen = (flags) => flags === undefined || flags === 'r' || flags === 'rs' || flags === fs.constants.O_RDONLY;   // anything else, string or numeric, is a write
  const check = (name, calls) => { for (const c of calls) {
    if (/^(promises\.)?open(Sync)?$/.test(name) && readOnlyOpen(c.arguments[1])) continue;
    const p = String(c.arguments[0]);
    assert.ok(p === scratchHome || p.startsWith(scratchHome + path.sep), `import wrote outside the scratch home (${name}): ${p}`);   // directory boundary, not a bare prefix
  } };
  writes.forEach((sp, i) => check(WRITE_APIS[i], sp.mock.calls));
  promised.forEach((sp, i) => check('promises.' + BASE[i], sp.mock.calls));
  [...shell, ...writes, ...promised].forEach((sp) => sp.mock.restore());
  return app;
};
