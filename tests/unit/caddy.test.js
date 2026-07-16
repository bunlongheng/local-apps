// Unit: Caddyfile block generation via the injected-deps factory. lib/caddy.js
// reads/writes fs.readFileSync/writeFileSync internally against whatever
// `caddyfile` path the factory is given, so every test here points at a
// throwaway file in a temp dir (never the real Caddyfile) and injects a fake
// `exec` so `caddy validate`/`caddy reload` never actually run.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const makeCaddy = require('../../lib/caddy');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-test-'));
  const caddyfile = path.join(dir, 'Caddyfile');
  const execCalls = [];
  const caddy = makeCaddy({
    caddyfile,
    errorRoot: '/tmp/error-root',
    getLanIp: () => '10.0.0.5',
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
  assert.ok(content.includes('reverse_proxy 10.0.0.5:4000'), 'reverse_proxy target present');
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
  assert.ok(content.includes('reverse_proxy 10.0.0.5:4002'), 'other id target must survive');
});

test('renameCaddyEntry removes the old id and adds the new id at the new port', () => {
  const { caddy, caddyfile } = fresh();
  caddy.addCaddyEntry('old-name', 4001);
  const domain = caddy.renameCaddyEntry('old-name', 'new-name', 4005);
  assert.equal(domain, 'http://new-name.localhost');
  const content = fs.readFileSync(caddyfile, 'utf8');
  assert.ok(!content.includes('old-name.localhost'), 'old id must be gone');
  assert.ok(content.includes('new-name.localhost'), 'new id must be present');
  assert.ok(content.includes('reverse_proxy 10.0.0.5:4005'), 'new port must be used');
});
