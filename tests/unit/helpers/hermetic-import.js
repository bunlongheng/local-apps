// Require server.js the way the route suites must: with every child_process function and every
// fs write spied at import, so a top-level shell-out or a write outside the scratch home fails
// loudly. Returns the app. Used by routes-security and routes-notoken.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');
const { mock } = require('node:test');

module.exports = function requireHermetic(scratchHome) {
  assert.equal(require.cache[require.resolve('../../../server')], undefined, 'server must not be preloaded: this file needs its own process');
  const shell = ['execSync', 'exec', 'execFile', 'spawn', 'spawnSync'].map((f) => mock.method(cp, f));
  const writes = ['mkdirSync', 'writeFileSync'].map((f) => mock.method(fs, f));
  const app = require('../../../server');
  for (const sp of shell) assert.equal(sp.mock.callCount(), 0, 'importing server.js must not shell out');
  for (const sp of writes) for (const c of sp.mock.calls) assert.ok(String(c.arguments[0]).startsWith(scratchHome) || String(c.arguments[0]).startsWith(os.tmpdir()), `import wrote outside the scratch home: ${c.arguments[0]}`);
  [...shell, ...writes].forEach((sp) => sp.mock.restore());
  return app;
};
