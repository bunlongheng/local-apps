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
test('--run measures the file itself into a private temp dir and applies the floor', () => {
  // A cheap sibling suite, never this file (it would spawn --run again, forever).
  // TMPDIR points at this test's own dir, so the cleanup check sees only what this run created.
  const r = spawnSync(process.execPath, [SCRIPT, '--run', 'public/sw.js', '50', '50', path.join(__dirname, 'sw.test.js')], { encoding: 'utf8', timeout: 120000, env: { ...process.env, TMPDIR: dir } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /public\/sw\.js lines \d+\.\d+%/);
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('coverage-floor-')).length, 0, 'temp dir removed');
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--run', 'public/sw.js', '101', '0', path.join(__dirname, 'sw.test.js')], { encoding: 'utf8', timeout: 120000 }).status, 1, 'floor applies to --run too');
});

test('--check judges every record of a report: one file under the floor fails even when the rest are fine; --all measures then judges', () => {
  const lcov2 = path.join(dir, 'all.info');
  fs.writeFileSync(lcov2, ['SF:/repo/lib/good.js', 'LF:100', 'LH:98', 'BRF:10', 'BRH:9', 'end_of_record', 'SF:/repo/lib/weak.js', 'LF:100', 'LH:60', 'BRF:10', 'BRH:9', 'end_of_record', ''].join('\n'));
  const low = spawnSync(process.execPath, [SCRIPT, '--check', lcov2, '70', '50'], { encoding: 'utf8' });
  assert.equal(low.status, 1); assert.match(low.stdout, /LOW .*weak\.js/); assert.match(low.stdout, /ok .*good\.js/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--check', lcov2, '50', '50'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--check', path.join(dir, 'missing.info'), '0', '0'], { encoding: 'utf8' }).status, 2);
  const all = spawnSync(process.execPath, [SCRIPT, '--all', '101', '0', 'public/sw.js', path.join(__dirname, 'sw.test.js')], { encoding: 'utf8', timeout: 120000, env: { ...process.env, TMPDIR: dir } });
  assert.equal(all.status, 1, all.stdout); assert.match(all.stdout, /LOW .*public\/sw\.js/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--all', '0', '0', 'public/sw.js', path.join(__dirname, 'sw.test.js')], { encoding: 'utf8', timeout: 120000, env: { ...process.env, TMPDIR: dir } }).status, 0);
});
