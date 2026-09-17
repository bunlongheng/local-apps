// Unit: LaunchAgent plist generation via the injected-deps factory. lib/launchd.js
// writes to whatever `launchAgentsDir` the factory is given, so every test here
// points at a throwaway temp dir (never ~/Library/LaunchAgents) and injects a
// fake `exec` so `launchctl unload` never actually runs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const makeLaunchd = require('../../lib/launchd');
const { xmlEscape } = require('../../lib/validate');

function fresh() {
  const launchAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-test-'));
  const execCalls = [];
  const launchd = makeLaunchd({
    username: 'tester',
    launchAgentsDir,
    npmPath: '/opt/homebrew/bin/npm',
    xmlEscape,
    exec: (cmd) => { execCalls.push(cmd); },
  });
  return { launchd, launchAgentsDir, execCalls };
}

test('createLaunchAgent writes a plist with the WorkingDirectory and returns its path', () => {
  const { launchd, launchAgentsDir } = fresh();
  const res = launchd.createLaunchAgent('my-app', '/tmp/my-app', '/tmp/my-app.log', 'npm run dev');
  assert.equal(res.launchAgent, 'com.tester.my-app');
  assert.equal(res.launchAgentPath, path.join(launchAgentsDir, 'com.tester.my-app.plist'));
  const plist = fs.readFileSync(res.launchAgentPath, 'utf8');
  assert.ok(plist.includes('<key>WorkingDirectory</key>\n\t<string>/tmp/my-app</string>'));
});

test('createLaunchAgent builds ProgramArguments from the startCommand, resolving npm via npmPath', () => {
  const { launchd } = fresh();
  const res = launchd.createLaunchAgent('my-app', '/tmp/my-app', '/tmp/my-app.log', 'npm run dev');
  const plist = fs.readFileSync(res.launchAgentPath, 'utf8');
  const arrayMatch = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  assert.ok(arrayMatch, 'ProgramArguments array present');
  const args = [...arrayMatch[1].matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
  assert.deepEqual(args, ['/opt/homebrew/bin/npm', 'run', 'dev']);
});

test('createLaunchAgent sets RunAtLoad and KeepAlive both false', () => {
  const { launchd } = fresh();
  const res = launchd.createLaunchAgent('my-app', '/tmp/my-app', '/tmp/my-app.log', 'npm run dev');
  const plist = fs.readFileSync(res.launchAgentPath, 'utf8');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
});

test('createLaunchAgent applies xmlEscape to values containing XML metacharacters', () => {
  const { launchd } = fresh();
  const res = launchd.createLaunchAgent('my-app', '/tmp/a & b"', '/tmp/log.log', 'npm run dev');
  const plist = fs.readFileSync(res.launchAgentPath, 'utf8');
  assert.ok(plist.includes('/tmp/a &amp; b&quot;'), 'metacharacters must be escaped');
  assert.ok(!plist.includes('/tmp/a & b"'), 'raw unescaped value must not appear');
});

test('createLaunchAgent is idempotent - a second call with an existing plist returns the same result and does not overwrite it', () => {
  const { launchd } = fresh();
  const first = launchd.createLaunchAgent('my-app', '/tmp/first', '/tmp/first.log', 'npm run dev');
  const before = fs.readFileSync(first.launchAgentPath, 'utf8');
  const second = launchd.createLaunchAgent('my-app', '/tmp/second', '/tmp/second.log', 'npm start');
  assert.deepEqual(second, first);
  const after = fs.readFileSync(first.launchAgentPath, 'utf8');
  assert.equal(after, before, 'plist must not be rewritten for an id that already has one');
});

test('createLaunchAgent returns nulls when localPath is missing', () => {
  const { launchd } = fresh();
  const res = launchd.createLaunchAgent('no-path', '', '/tmp/log.log', 'npm run dev');
  assert.deepEqual(res, { launchAgent: null, launchAgentPath: null });
});

test('removeLaunchAgent unloads via the injected exec and deletes the plist file', () => {
  const { launchd, execCalls } = fresh();
  const res = launchd.createLaunchAgent('gone-app', '/tmp/gone-app', '/tmp/gone-app.log', 'npm run dev');
  assert.ok(fs.existsSync(res.launchAgentPath));
  launchd.removeLaunchAgent('gone-app');
  assert.ok(!fs.existsSync(res.launchAgentPath), 'plist must be deleted');
  assert.ok(execCalls.some(c => c.includes('launchctl unload') && c.includes(res.launchAgentPath)));
});
