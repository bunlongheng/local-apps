// Require server.js the way the route suites must: with every child_process function and every
// fs write API spied at import, so a top-level shell-out or a write anywhere but the scratch home
// (not even elsewhere under os.tmpdir()) fails loudly. Returns the app. Used by routes-security
// and routes-notoken.
const assert = require('node:assert');
const fs = require('node:fs');
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
  const check = (name, calls) => { for (const c of calls) {
    if (/^open/.test(name) && !/[wa+]/.test(String(typeof c.arguments[1] === 'string' ? c.arguments[1] : 'r'))) continue;   // a read-only open is not a write
    assert.ok(String(c.arguments[0]).startsWith(scratchHome), `import wrote outside the scratch home (${name}): ${c.arguments[0]}`);
  } };
  writes.forEach((sp, i) => check(WRITE_APIS[i], sp.mock.calls));
  promised.forEach((sp, i) => check('promises.' + BASE[i], sp.mock.calls));
  [...shell, ...writes, ...promised].forEach((sp) => sp.mock.restore());
  return app;
};
