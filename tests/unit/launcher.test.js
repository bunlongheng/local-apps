// Unit: lib/launcher.js - the feed the launcher extension syncs (pure).
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLauncher } = require('../../lib/launcher');

const APPS = [
  { id: 'alpha', name: 'Alpha', prodUrl: 'https://alpha.example.app', localUrl: 'http://localhost:4000', repo: 'https://github.com/x/alpha', tabColor: '#123456', tabIcon: 'A', localPath: '/Users/YOU/Sites/alpha', logPath: '/tmp/alpha.log' },
  { id: 'beta', name: 'Beta', prodUrl2: 'https://beta.example.com', localUrl: 'http://localhost:4001' },
  { id: 'gamma', name: 'Gamma', localUrl: 'http://localhost:4002', repo: 'https://github.com/x/gamma' },
];

test('only apps with a hosted url are included', () => {
  const { apps } = buildLauncher(APPS);
  assert.deepEqual(apps.map(a => a.id), ['alpha', 'beta'], 'gamma has no prod url and must not be launchable');
});

test('document carries no local paths, plists, logs or ports', () => {
  const json = JSON.stringify(buildLauncher(APPS));
  for (const leak of ['localPath', 'logPath', '/Users/', '/tmp/', 'launchAgent', 'localhost:4000']) {
    assert.ok(!json.includes(leak), `${leak} must not leave the machine`);
  }
});

test('tail url only for apps that are up, and only when a tailscale ip is known', () => {
  const stateOf = (id) => ({ status: id === 'alpha' ? 'up' : 'down' });
  const withIp = buildLauncher(APPS, { tailscaleIp: '1.2.3.4', stateOf });
  assert.equal(withIp.apps[0].urls.tail, 'http://1.2.3.4:4000');
  assert.equal(withIp.apps[1].urls.tail, undefined, 'beta is down');
  const noIp = buildLauncher(APPS, { stateOf });
  assert.equal(noIp.apps[0].urls.tail, undefined);
});

test('version is a stable content hash', () => {
  const a = buildLauncher(APPS).version, b = buildLauncher(APPS).version;
  assert.equal(a, b);
  assert.notEqual(a, buildLauncher(APPS.slice(0, 1)).version);
  assert.match(a, /^[a-f0-9]{12}$/);
});

test('aliases include id and lowercased name, host is the prod host', () => {
  const { apps } = buildLauncher(APPS);
  assert.deepEqual(apps[0].aliases, ['alpha']);
  assert.equal(apps[0].host, 'alpha.example.app');
  assert.deepEqual(apps[0].urls, { prod: 'https://alpha.example.app', repo: 'https://github.com/x/alpha' });
});
