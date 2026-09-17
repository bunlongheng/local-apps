// Unit: Caddyfile block generation via the injected-deps factory. lib/caddy.js
// reads/writes fs.readFileSync/writeFileSync internally against whatever
// `caddyfile` path the factory is given, so every test here points at a
// throwaway file in a temp dir (never the real Caddyfile) and injects a fake
// `exec` so `caddy validate`/`caddy reload` never actually run.
const { test, after, mock } = require('node:test');
const TMP_DIRS = [];
after(() => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); });
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const makeCaddy = require('../../lib/caddy');

function fresh() {
  const dir = TMP_DIRS[TMP_DIRS.push(fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-test-'))) - 1];
  const caddyfile = path.join(dir, 'Caddyfile');
  const execCalls = [];
  const caddy = makeCaddy({
    caddyfile,
    errorRoot: '/tmp/error-root',
    getLanIp: () => '1.2.3.4',
    exec: (cmd) => { execCalls.push(cmd); },
  });
  return { caddy, caddyfile, execCalls };
}

test('getCaddyfile returns empty string when the file does not exist yet', () => {
  const { caddy } = fresh();
  assert.equal(caddy.getCaddyfile(), '');
});

test('addCaddyEntry writes a block with the hostname and reverse_proxy target', () => {
  const { caddy, caddyfile } = fresh();
  const domain = caddy.addCaddyEntry('myapp', 4000);
  assert.equal(domain, 'http://myapp.localhost');
  const content = fs.readFileSync(caddyfile, 'utf8');
  assert.ok(content.includes('http://myapp.localhost {'), 'block header present');
  assert.ok(content.includes('reverse_proxy 127.0.0.1:4000'), 'reverse_proxy target present');
});

test('addCaddyEntry validates then reloads caddy via the injected exec', () => {
  const { caddy, execCalls } = fresh();
  caddy.addCaddyEntry('myapp', 4000);
  assert.equal(execCalls.length, 2);
  assert.match(execCalls[0], /caddy validate --config/);
  assert.match(execCalls[1], /caddy reload --config/);
});

test('addCaddyEntry is idempotent - re-adding the same id does not duplicate the block', () => {
  const { caddy, caddyfile, execCalls } = fresh();
  caddy.addCaddyEntry('myapp', 4000);
  execCalls.length = 0;
  const domain = caddy.addCaddyEntry('myapp', 4000);
  assert.equal(domain, 'http://myapp.localhost');
  const content = fs.readFileSync(caddyfile, 'utf8');
  const occurrences = content.match(/myapp\.localhost/g) || [];
  assert.equal(occurrences.length, 1, 'hostname block must appear exactly once');
  assert.equal(execCalls.length, 0, 'no-op add must not touch caddy');
});

test('removeCaddyEntry removes only the matching block, leaving other entries intact', () => {
  const { caddy, caddyfile } = fresh();
  caddy.addCaddyEntry('one', 4001);
  caddy.addCaddyEntry('two', 4002);
  caddy.removeCaddyEntry('one');
  const content = fs.readFileSync(caddyfile, 'utf8');
  assert.ok(!content.includes('one.localhost'), 'removed id must be gone');
  assert.ok(content.includes('two.localhost'), 'other id must survive');
  assert.ok(content.includes('reverse_proxy 127.0.0.1:4002'), 'other id target must survive');
});

test('renameCaddyEntry removes the old id and adds the new id at the new port', () => {
  const { caddy, caddyfile } = fresh();
  caddy.addCaddyEntry('old-name', 4001);
  const domain = caddy.renameCaddyEntry('old-name', 'new-name', 4005);
  assert.equal(domain, 'http://new-name.localhost');
  const content = fs.readFileSync(caddyfile, 'utf8');
  assert.ok(!content.includes('old-name.localhost'), 'old id must be gone');
  assert.ok(content.includes('new-name.localhost'), 'new id must be present');
  assert.ok(content.includes('reverse_proxy 127.0.0.1:4005'), 'new port must be used');
});

test('adding an entry installs the shipped offline.html next to the Caddyfile', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = TMP_DIRS[TMP_DIRS.push(fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-off-'))) - 1];
  const cf = path.join(dir, 'Caddyfile'); fs.writeFileSync(cf, '');
  const caddy = require('../../lib/caddy')({ caddyfile: cf, errorRoot: dir, getLanIp: () => '1.2.3.4', exec: () => {} });
  caddy.addCaddyEntry('zzz-off', 4010);
  assert.ok(fs.existsSync(path.join(dir, 'offline.html')), 'offline.html copied into errorRoot');
  assert.match(fs.readFileSync(path.join(dir, 'offline.html'), 'utf8'), /not running/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addCaddyEntry is an upsert: a new port rewrites the block, the same port is a no-op', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = TMP_DIRS[TMP_DIRS.push(fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-up-'))) - 1]; const cf = path.join(dir, 'Caddyfile'); fs.writeFileSync(cf, '');
  const caddy = require('../../lib/caddy')({ caddyfile: cf, errorRoot: dir, getLanIp: () => '1.2.3.4', exec: () => {} });
  caddy.addCaddyEntry('zzz-up', 3000); caddy.addCaddyEntry('zzz-up', 4000);
  const c = fs.readFileSync(cf, 'utf8');
  assert.equal((c.match(/zzz-up\.localhost \{/g) || []).length, 1, 'exactly 1 block');
  assert.match(c, /reverse_proxy 127\.0\.0\.1:4000/); assert.doesNotMatch(c, /127\.0\.0\.1:3000/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a candidate Caddyfile that fails validation never replaces the live file', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = TMP_DIRS[TMP_DIRS.push(fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-val-'))) - 1]; const cf = path.join(dir, 'Caddyfile'); fs.writeFileSync(cf, '# live\n');
  const caddy = require('../../lib/caddy')({ caddyfile: cf, errorRoot: dir, getLanIp: () => '1.2.3.4', exec: (cmd) => { if (/validate/.test(cmd)) throw new Error('adapt failed'); } });
  assert.equal(caddy.addCaddyEntry('zzz-bad', 4001), null, 'no proxy URL for a block that was never written');
  assert.equal(fs.readFileSync(cf, 'utf8'), '# live\n', 'live Caddyfile untouched'); assert.ok(!fs.existsSync(cf + '.candidate'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing reload is a warning: the block is on disk, the domain is returned, and the failure is reported once', () => {
  const fs2 = require('node:fs'), dir = TMP_DIRS[TMP_DIRS.push(fs2.mkdtempSync(path.join(os.tmpdir(), 'caddy-reload-'))) - 1];
  const cf = path.join(dir, 'Caddyfile'); fs2.writeFileSync(cf, '');
  const warn = mock.method(console, 'warn', () => {});
  const caddy = require('../../lib/caddy')({ caddyfile: cf, errorRoot: dir, getLanIp: () => '1.2.3.4', exec: (cmd) => { if (/^caddy reload/.test(cmd)) throw new Error('admin endpoint down'); } });
  assert.equal(caddy.addCaddyEntry('zzz-r', 4002), 'http://zzz-r.localhost');
  assert.ok(fs2.readFileSync(cf, 'utf8').includes('zzz-r.localhost'), 'block written despite the failed reload');
  assert.equal(warn.mock.callCount(), 1); assert.match(String(warn.mock.calls[0].arguments[0]), /caddy reload failed/);
  warn.mock.restore();
});

test('removeCaddyEntry returns false and keeps the block when the candidate is rejected; no reload', () => {
  const fs2 = require('node:fs'), dir = TMP_DIRS[TMP_DIRS.push(fs2.mkdtempSync(path.join(os.tmpdir(), 'caddy-rm-'))) - 1];
  const cf = path.join(dir, 'Caddyfile'); fs2.writeFileSync(cf, '');
  let reject = false; const cmds = [];
  const caddy = require('../../lib/caddy')({ caddyfile: cf, errorRoot: dir, getLanIp: () => '1.2.3.4', exec: (cmd) => { cmds.push(cmd); if (reject && /^caddy validate/.test(cmd)) throw new Error('adapt failed'); } });
  caddy.addCaddyEntry('one', 4003); cmds.length = 0; reject = true;
  assert.equal(caddy.removeCaddyEntry('one'), false);
  assert.ok(fs2.readFileSync(cf, 'utf8').includes('one.localhost'), 'block still live'); assert.ok(!cmds.some(c => /^caddy reload/.test(c)), 'no reload of an unchanged file');
  reject = false; assert.equal(caddy.removeCaddyEntry('one'), true); assert.equal(caddy.removeCaddyEntry('one'), true, 'nothing to remove is fine');
});
