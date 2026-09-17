// Unit: lib/tab-colors.js against a temp home - the id key wins, the caddy host is the fallback,
// labels are uppercased, and a missing registry is a no-op.
const { test, after } = require('node:test');
const TMP_DIRS = [];
after(() => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); });
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const makeTabColors = require('../../lib/tab-colors');

function home(registry) {
  const h = TMP_DIRS[TMP_DIRS.push(fs.mkdtempSync(path.join(os.tmpdir(), 'tabs-'))) - 1];
  if (registry) { fs.mkdirSync(path.join(h, '.claude')); fs.writeFileSync(path.join(h, '.claude', 'tab-colors.json'), JSON.stringify(registry)); }
  return h;
}
const read = (h) => JSON.parse(fs.readFileSync(path.join(h, '.claude', 'tab-colors.json'), 'utf8'));

test('renames the entry keyed by app id, uppercased', () => {
  const h = home({ alpha: { label: 'OLD', r: 1, g: 2, b: 3 }, other: { label: 'X' } });
  const { updateTabColors } = makeTabColors({ home: h, dbg: () => {} });
  assert.equal(updateTabColors('alpha', 'New Name', 'http://alpha.localhost'), true);
  assert.deepEqual(read(h), { alpha: { label: 'NEW NAME', r: 1, g: 2, b: 3 }, other: { label: 'X' } });
});

test('falls back to the Caddy hostname key when the id is not registered; unknown keys are untouched', () => {
  const h = home({ custom: { label: 'C' } });
  const { updateTabColors } = makeTabColors({ home: h, dbg: () => {} });
  assert.equal(updateTabColors('alpha', 'renamed', 'http://custom.localhost:8080/x'), true);
  assert.equal(read(h).custom.label, 'RENAMED');
  assert.equal(updateTabColors('nope', 'x', 'http://nowhere.localhost'), false);
  assert.deepEqual(Object.keys(read(h)), ['custom']);
});

test('a missing registry is a no-op that never throws', () => {
  const h = home(null); const seen = [];
  const { updateTabColors } = makeTabColors({ home: h, dbg: (w) => seen.push(w) });
  assert.equal(updateTabColors('alpha', 'x', null), false);
  assert.deepEqual(seen, ['updateTabColors']); assert.ok(!fs.existsSync(path.join(h, '.claude')));
});
