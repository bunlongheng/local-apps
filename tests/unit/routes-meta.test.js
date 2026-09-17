// Unit: routes/meta.js hub extras that read the owner's home: tab-colors merge + alias, icon-sync
// byte comparison, capabilities detection - all against a temp home and temp app dirs.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-home-'));
const faviconsDir = path.join(home, 'favicons'); fs.mkdirSync(faviconsDir);   // the route reads favicons from ctx, never the source tree
const FIXTURE_FAV = path.join(faviconsDir, 'zzz-meta.png');
after(() => fs.rmSync(home, { recursive: true, force: true }));
const write = (rel, body) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };

function fakeApp() {
  const routes = {}, app = {};
  for (const m of ['get', 'post', 'put', 'delete']) app[m] = (p, fn) => { routes[`${m.toUpperCase()} ${p}`] = fn; };
  return { app, routes };
}
function call(fn, { params = {}, query = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() {}, json(b) { resolve({ status: this.statusCode, body: b }); } };
    Promise.resolve(fn({ params, query, headers, hostname: (headers.host || '').split(':')[0], body: {} }, res)).catch(reject);
  });
}
function boot(apps, tabColors = {}) {
  const { app, routes } = fakeApp();
  require('../../routes/meta')(app, { LAN_IP: () => '10.0.0.5', IS_HUB: true, db: { getApps: () => apps, getApp: (id) => apps.find(a => a.id === id) || null, getTabColors: () => tabColors, upsertApp: () => {} }, dbg: () => {}, QRCode: require('qrcode'), PORT: 9875, home, faviconsDir });
  return routes;
}

test('tab-colors merges the json registry (hex colour, label), db fallback, and the shell alias', async () => {
  write('.claude/tab-colors.json', JSON.stringify({ alpha: { label: 'ALPHA', r: 255, g: 0, b: 16, icon: 'a' }, beta: { r: 1, g: 2, b: 3 } }));
  write('.claude-tabs.sh', '_alpha() { _tab "alpha"; }\n_beta() { _tab "beta"; }\n');
  const routes = boot([], { gamma: { label: 'G', color: '#010203' }, alpha: { label: 'IGNORED', color: '#000000' } });
  const r = await call(routes['GET /api/tab-colors']);
  assert.deepEqual(r.body.alpha, { label: 'ALPHA', color: '#ff0010', icon: 'a', alias: '_alpha' });
  assert.deepEqual(r.body.beta, { label: 'BETA', color: '#010203', icon: '', alias: '_beta' });
  assert.deepEqual(r.body.gamma, { label: 'G', color: '#010203' }, 'db entry fills in only when the json lacks the key');
});

test('icon-sync reports synced only when the favicon and the app icon are the same size', async () => {
  fs.writeFileSync(FIXTURE_FAV, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const favId = 'zzz-meta';
  const same = path.join(home, 'apps', favId); fs.mkdirSync(path.join(same, 'app'), { recursive: true });
  fs.copyFileSync(FIXTURE_FAV, path.join(same, 'app', 'icon.png'));
  const diff = path.join(home, 'apps', 'zzz-diff'); fs.mkdirSync(path.join(diff, 'public'), { recursive: true }); fs.writeFileSync(path.join(diff, 'public', 'favicon.png'), 'x');
  const routes = boot([{ id: favId, localPath: same }, { id: 'zzz-diff', localPath: diff }, { id: 'zzz-none' }]);
  const r = await call(routes['GET /api/icon-sync']);
  assert.deepEqual(r.body[favId], { hasFavicon: true, hasAppIcon: true, synced: true });
  assert.deepEqual(r.body['zzz-diff'], { hasFavicon: false, hasAppIcon: true, synced: false });
  assert.deepEqual(r.body['zzz-none'], { hasFavicon: false, hasAppIcon: false, synced: false });
});

test('capabilities detects MCP (project .mcp.json or global ref), API dirs, and a CLI (bin field or ~/.local/bin script)', async () => {
  const mk = (id, files) => { const d = path.join(home, 'apps', id); for (const [rel, body] of Object.entries(files)) { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); } return d; };
  const mcp = mk('zzz-mcp', { '.mcp.json': '{}', 'package.json': '{}' });
  const api = mk('zzz-api', { 'app/api/route.js': '', 'package.json': '{"bin":"cli.js"}' });
  const plain = mk('zzz-plain', { 'index.js': '' });
  write('.claude/.mcp.json', JSON.stringify({ mcpServers: { plainsrv: { args: ['/x/zzz-plain/server.js'] } } }));
  write('.local/bin/zzz-plain-cli', '#!/bin/sh\nnode /x/zzz-plain/cli.js\n');
  const routes = boot([{ id: 'zzz-mcp', localPath: mcp }, { id: 'zzz-api', localPath: api }, { id: 'zzz-plain', localPath: plain }, { id: 'zzz-gone', localPath: path.join(home, 'nope') }]);
  const r = await call(routes['GET /api/capabilities']);
  assert.deepEqual(r.body['zzz-mcp'], { mcp: true, mcpPath: path.join(mcp, '.mcp.json') });
  assert.deepEqual(r.body['zzz-api'], { api: true, cli: true });
  assert.deepEqual(r.body['zzz-plain'], { mcp: true, mcpName: 'plainsrv', cli: true, cliBin: 'zzz-plain-cli' });
  assert.equal(r.body['zzz-gone'], undefined, 'a missing dir is skipped');
});
