// Unit: the IS_MAIN boot path of server.js, run for real as a child on a free port with scratch
// paths: the banner, a live /api/status, the guarded tick, and a clean exit on SIGTERM.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('node server.js boots on PORT, prints the banner, serves /api/status, runs its first tick, and stops on SIGTERM', async () => {
  // The tick's rejection guard is behaviourally tested in monitor.test.js (guardedTick).
  const port = await freePort();
  // Seed 1 app on a port nobody listens on: the first tick must observe it down.
  const dead = await freePort();
  fs.writeFileSync(path.join(dir, 'apps.config.json'), JSON.stringify([{ id: 'zzz-boot', name: 'Boot', localUrl: `http://127.0.0.1:${dead}`, healthUrl: `http://127.0.0.1:${dead}` }]));
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), MACHINE_ROLE: 'agent', API_BIND: '127.0.0.1', LOCAL_APPS_DB: path.join(dir, 'boot.db'), LOCAL_APPS_CONFIG: path.join(dir, 'apps.config.json'), LOCAL_APPS_HOME: dir, LOCAL_APPS_LOG_DIR: path.join(dir, 'logs'), CADDYFILE: path.join(dir, 'Caddyfile'), LAUNCH_AGENTS_DIR: dir, LOCAL_APPS_FAVICONS_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  try {
    for (let i = 0; i < 100 && !/running at:/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:${port}`), 'banner names the bound address:\n' + out);
    assert.match(out, /Role:\s+AGENT/);
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.machineRole, 'agent'); assert.ok(Array.isArray(j.apps));
    let row = null;
    for (let i = 0; i < 100 && !(row && row.status === 'down' && row.lastChecked); i++) {
      row = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).apps.find((a) => a.id === 'zzz-boot');
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(row && row.status === 'down' && row.lastChecked, 'the first tick probed the seeded app and marked it down: ' + JSON.stringify(row));
    assert.ok(!/checkAll failed/.test(out), 'the first tick ran clean:\n' + out);
  } finally { child.kill('SIGTERM'); }
  const { sig } = await exited; assert.equal(sig, 'SIGTERM');
});
