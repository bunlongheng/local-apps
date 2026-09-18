// Unit: the shipped shell scripts parse, refuse bad input, and their read-only modes run.
// onboard-app.sh --dry-run prints the 9-step plan and touches nothing; storage-guard.sh report is
// read-only by design. The mutating paths need a GitHub account, Vercel and a Mac, so they stay
// out of the suite; shellcheck runs in CI.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = ['scripts/onboard-app.sh', 'scripts/storage-guard.sh', 'start.sh'];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const sh = (args, env = {}) => spawnSync('bash', args, { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: home, ...env } });

test('every shipped shell script parses', () => {
  for (const f of SCRIPTS) { const r = sh(['-n', f]); assert.equal(r.status, 0, `${f}: ${r.stderr}`); }
});

test('onboard-app.sh without its 3 arguments prints usage and exits 1, running nothing', () => {
  const r = sh(['scripts/onboard-app.sh']);
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /Usage: \.\/onboard-app\.sh <app-id> <app-name> <local-path>/);
});

test('onboard-app.sh --dry-run prints the 9 steps in order with the resolved arguments and creates nothing', () => {
  const r = sh(['scripts/onboard-app.sh', 'zzz-app', 'Zzz App', '/tmp/zzz-app', '--color', '1,2,3', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const steps = r.stdout.split('\n').filter((l) => /^ {2}[1-9]\. /.test(l));
  assert.deepEqual(steps.map((l) => l.trim().slice(0, 2)), ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.']);
  assert.match(r.stdout, /DRY RUN for zzz-app \(Zzz App\) at \/tmp\/zzz-app, color 1,2,3/);
  assert.match(steps[1], /POST http:\/\/localhost:9875\/api\/apps .*id: zzz-app/);
  assert.ok(!fs.existsSync(path.join(home, '.claude-tabs.sh')) && fs.readdirSync(home).length === 0, 'nothing written under HOME');
});

test('storage-guard.sh report is read-only, prints the reclaim table and exits with a level code', () => {
  const r = sh(['scripts/storage-guard.sh', 'report']);
  assert.ok([0, 1, 2].includes(r.status), `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /npm cache/); assert.match(r.stdout, /Trash/);
  assert.equal(fs.readdirSync(home).length, 0, 'report mode writes nothing under HOME');
});
