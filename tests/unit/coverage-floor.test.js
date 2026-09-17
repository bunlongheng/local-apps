// Unit: scripts/coverage-floor.js - the per-file gate reads the right lcov record and exits by the floor.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'coverage-floor.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const lcov = path.join(dir, 'lcov.info');
// 2 records whose paths share a suffix: the floor must pick public/app.js, never lib/app.js.
fs.writeFileSync(lcov, ['SF:/repo/lib/app.js', 'LF:10', 'LH:1', 'BRF:10', 'BRH:1', 'end_of_record', 'SF:/repo/public/app.js', 'LF:100', 'LH:83', 'BRF:200', 'BRH:130', 'end_of_record', ''].join('\n'));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, lcov, ...args], { encoding: 'utf8' });

test('exit 0 above the floor, reporting the numbers of the matched file', () => {
  const r = run('public/app.js', '80', '60');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /public\/app\.js lines 83\.00% .* branches 65\.00%/);
});
test('exit 1 below the floor on either axis', () => {
  assert.equal(run('public/app.js', '90', '60').status, 1); assert.equal(run('public/app.js', '80', '70').status, 1);
});
test('exit 2 when the file has no record; a shorter suffix does not borrow another file', () => {
  assert.equal(run('nope/app.js', '0', '0').status, 2);
  const r = run('lib/app.js', '0', '0'); assert.equal(r.status, 0); assert.match(r.stdout, /lib\/app\.js lines 10\.00%/);
});
