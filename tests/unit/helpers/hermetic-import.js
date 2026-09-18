// Require server.js the way the route suites must: with every child_process function and every
// fs write API spied at import, so a top-level shell-out or a write anywhere but the scratch home
// (not even elsewhere under os.tmpdir()) fails loudly. Returns the app. Used by routes-security
// and routes-notoken.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { mock } = require('node:test');

module.exports = function requireHermetic(scratchHome, load = () => require('../../../server')) {
  assert.equal(require.cache[require.resolve('../../../server')], undefined, 'server must not be preloaded: this file needs its own process');
  // Every spawner node:child_process exports, closed by construction like the fs list below.
  const SHELL = ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'];
  for (const k of Object.keys(cp)) if (/^(exec|spawn|fork)/.test(k) && typeof cp[k] === 'function') assert.ok(SHELL.includes(k), `child_process.${k} is not covered by the hermetic import spies`);
  const shell = SHELL.map((f) => mock.method(cp, f));
  // Sync, callback and promise forms: a call is recorded at import even when its I/O completes later.
  const BASE = ['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'copyFile', 'cp', 'rename', 'rm', 'rmdir', 'unlink', 'symlink', 'link', 'truncate', 'chmod', 'chown', 'lchmod', 'lchown', 'utimes', 'lutimes', 'open'];
  const FD_BASE = ['write', 'writev', 'fchmod', 'fchown', 'ftruncate', 'futimes'];   // take an fd, not a path: must not be called at all
  // Closed by construction: every fs export that mutates must be in one of the 2 lists, so a new
  // Node mutator fails here instead of slipping past the spies.
  const MUTATOR = /^(mkdir|mkdtemp|write|writev|append|copy|cp|rename|rm|unlink|symlink|link|truncate|chmod|chown|lchmod|lchown|utimes|lutimes|open|fchmod|fchown|ftruncate|futimes)/;
  const known = new Set([...BASE, ...FD_BASE, 'createWriteStream', 'openAsBlob', 'opendir']);   // openAsBlob/opendir read
  for (const k of Object.keys(fs)) if (MUTATOR.test(k) && typeof fs[k] === 'function') assert.ok(known.has(k.replace(/Sync$/, '')), `fs.${k} is not covered by the hermetic import spies`);
  // Some mutators are platform-specific (lchmod is macOS-only), so spy what this fs exports.
  const WRITE_APIS = [...BASE.map((f) => f + 'Sync'), ...BASE, 'createWriteStream'].filter((f) => typeof fs[f] === 'function');
  const writes = WRITE_APIS.map((f) => mock.method(fs, f));
  const fdWrites = [...FD_BASE.map((f) => f + 'Sync'), ...FD_BASE].filter((f) => typeof fs[f] === 'function').map((f) => mock.method(fs, f));
  const promised = BASE.filter((f) => typeof fs.promises[f] === 'function').map((f) => mock.method(fs.promises, f));
  const app = load();
  for (const sp of shell) assert.equal(sp.mock.callCount(), 0, 'importing server.js must not shell out');
  const readOnlyOpen = (flags) => flags === undefined || flags === 'r' || flags === 'rs' || flags === fs.constants.O_RDONLY;   // anything else, string or numeric, is a write
  const inScratch = (p) => p === scratchHome || p.startsWith(scratchHome + path.sep);   // directory boundary, not a bare prefix
  // The argument that gets written: the destination for copy/cp/symlink/link, both ends for rename.
  const writtenArgs = (name) => /^(promises\.)?(copyFile|cp|symlink|link)(Sync)?$/.test(name) ? [1] : /^(promises\.)?rename(Sync)?$/.test(name) ? [0, 1] : [0];
  const check = (name, calls) => { for (const c of calls) {
    if (/^(promises\.)?open(Sync)?$/.test(name) && readOnlyOpen(c.arguments[1])) continue;
    for (const i of writtenArgs(name)) assert.ok(inScratch(String(c.arguments[i])), `import wrote outside the scratch home (${name}): ${c.arguments[i]}`);
  } };
  writes.forEach((sp, i) => check(WRITE_APIS[i], sp.mock.calls));
  for (const sp of fdWrites) assert.equal(sp.mock.callCount(), 0, 'import must not write through a file descriptor');
  const promisedNames = BASE.filter((f) => typeof fs.promises[f] === 'function');
  promised.forEach((sp, i) => check('promises.' + promisedNames[i], sp.mock.calls));
  [...shell, ...writes, ...fdWrites, ...promised].forEach((sp) => sp.mock.restore());
  return app;
};
