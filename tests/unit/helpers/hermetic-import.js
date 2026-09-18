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
  const WRITE_APIS = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'openSync'];
  const writes = WRITE_APIS.map((f) => mock.method(fs, f));
  const app = require('../../../server');
  for (const sp of shell) assert.equal(sp.mock.callCount(), 0, 'importing server.js must not shell out');
  for (const [i, sp] of writes.entries()) for (const c of sp.mock.calls) {
    if (WRITE_APIS[i] === 'openSync' && !/[wa+]/.test(String(c.arguments[1] || 'r'))) continue;   // a read-only open is not a write
    assert.ok(String(c.arguments[0]).startsWith(scratchHome), `import wrote outside the scratch home (${WRITE_APIS[i]}): ${c.arguments[0]}`);
  }
  [...shell, ...writes].forEach((sp) => sp.mock.restore());
  return app;
};
