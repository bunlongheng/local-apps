// Unit: the hermetic-import helper itself catches what it claims to: a shell-out, a write outside
// the scratch home, a copy or link whose destination leaves it, and a rename into the real home.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const requireHermetic = require('./helpers/hermetic-import');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
fs.writeFileSync(path.join(scratch, 'a'), 'a');
const hermetic = (load) => requireHermetic(scratch, load);

test('a clean loader passes and its value is returned', () => {
  assert.equal(hermetic(() => { fs.mkdirSync(path.join(scratch, 'logs'), { recursive: true }); return 'app'; }), 'app');
});

test('a shell-out at import fails, whichever spawner is used', () => {
  assert.throws(() => hermetic(() => cp.execFileSync(process.execPath, ['-e', '0'])), /must not shell out/);
  assert.throws(() => hermetic(() => cp.execSync('true')), /must not shell out/);
});

test('a write outside the scratch home fails, on the destination side of copy, link and rename', () => {
  assert.throws(() => hermetic(() => fs.writeFileSync(path.join(outside, 'w'), 'x')), /wrote outside the scratch home \(writeFileSync\)/);
  assert.throws(() => hermetic(() => fs.copyFileSync(path.join(scratch, 'a'), path.join(outside, 'b'))), /wrote outside the scratch home \(copyFileSync\)/);
  assert.throws(() => hermetic(() => fs.symlinkSync(path.join(scratch, 'a'), path.join(outside, 'l'))), /symlinkSync/);
  fs.writeFileSync(path.join(scratch, 'r'), 'r');
  assert.throws(() => hermetic(() => fs.renameSync(path.join(scratch, 'r'), path.join(outside, 'a2'))), /renameSync/);
  // A directory whose name merely starts with the scratch path is outside it.
  const sibling = scratch + '-sibling'; fs.mkdirSync(sibling, { recursive: true });
  assert.throws(() => hermetic(() => fs.copyFileSync(path.join(scratch, 'a'), path.join(sibling, 'c'))), /copyFileSync/, 'a sibling dir sharing the prefix is outside');
  fs.rmSync(sibling, { recursive: true, force: true });
});

test('a write through a file descriptor at import fails', () => {
  assert.throws(() => hermetic(() => { const fd = fs.openSync(path.join(scratch, 'fd'), 'w'); fs.writeSync(fd, 'x'); fs.closeSync(fd); }), /file descriptor/);
});
