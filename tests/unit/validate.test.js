const { test } = require('node:test');
const assert = require('node:assert');
const { isValidId, isSafePath, isSafeCommand, isSafeLaunchAgent, isSafeLaunchAgentPath, isSafeSegment, validateAppFields, xmlEscape } = require('../../lib/validate');

test('isValidId accepts kebab-case ids', () => {
  assert.ok(isValidId('my-app'));
  assert.ok(isValidId('app123'));
  assert.ok(!isValidId('Bad ID'));
  assert.ok(!isValidId('-leading'));
  assert.ok(!isValidId(''));
  assert.ok(!isValidId('a'.repeat(65)));
});

test('isSafePath requires absolute path, rejects shell/XML metachars', () => {
  assert.ok(isSafePath('/Users/me/Sites/app'));
  assert.ok(isSafePath('/tmp/with space/ok'));
  assert.ok(!isSafePath('relative/path'));
  assert.ok(!isSafePath('/tmp/x";touch /tmp/pwned;"'));
  assert.ok(!isSafePath('/tmp/a$(whoami)'));
  assert.ok(!isSafePath('/tmp/a<b'));
});

test('isSafeCommand allows normal command lines, rejects operators', () => {
  assert.ok(isSafeCommand('npm run dev'));
  assert.ok(isSafeCommand('next dev -p 9876 --hostname 0.0.0.0'));
  assert.ok(!isSafeCommand('npm run dev; rm -rf /'));
  assert.ok(!isSafeCommand('a && b'));
  assert.ok(!isSafeCommand('$(evil)'));
});

test('validateAppFields returns null when clean, message when not', () => {
  assert.equal(validateAppFields({ localPath: '/tmp/ok', startCommand: 'npm run dev' }), null);
  assert.equal(validateAppFields({}), null);
  assert.match(validateAppFields({ localPath: '/tmp/x";evil' }), /localPath/);
  assert.match(validateAppFields({ startCommand: 'a; b' }), /startCommand/);
  assert.match(validateAppFields({ logPath: 'notabs' }), /logPath/);
});

test('xmlEscape escapes all five entities', () => {
  assert.equal(xmlEscape(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
  assert.equal(xmlEscape('/tmp/normal'), '/tmp/normal');
});

test('isSafeLaunchAgent accepts plain launchd labels, rejects shell injection', () => {
  assert.ok(isSafeLaunchAgent('com.bheng.local-apps'));
  assert.ok(isSafeLaunchAgent('com.bheng.my_app-2'));
  assert.ok(!isSafeLaunchAgent('x; touch /tmp/pwned; #'));
  assert.ok(!isSafeLaunchAgent('a b'));
  assert.ok(!isSafeLaunchAgent('$(evil)'));
  assert.ok(!isSafeLaunchAgent(''));
});

test('isSafeLaunchAgentPath requires an absolute .plist with no metacharacters', () => {
  assert.ok(isSafeLaunchAgentPath('/Users/bheng/Library/LaunchAgents/com.bheng.foo.plist'));
  assert.ok(!isSafeLaunchAgentPath('/Users/bheng/x.txt'));
  assert.ok(!isSafeLaunchAgentPath('relative/x.plist'));
  assert.ok(!isSafeLaunchAgentPath('/tmp/a";evil.plist'));
});

test('isSafeSegment blocks path traversal in URL segments', () => {
  assert.ok(isSafeSegment('repo-audit'));
  assert.ok(isSafeSegment('my_skill.v2'));
  assert.ok(!isSafeSegment('..'));
  assert.ok(!isSafeSegment('a/b'));
  assert.ok(!isSafeSegment('%2e%2e'));
});

test('validateAppFields rejects unsafe launchAgent + launchAgentPath (the RCE vector)', () => {
  assert.match(validateAppFields({ launchAgent: 'x; touch /tmp/pwned; #' }), /launchAgent/);
  assert.match(validateAppFields({ launchAgentPath: '/tmp/a";evil' }), /launchAgentPath/);
  assert.equal(validateAppFields({ launchAgent: 'com.bheng.ok', launchAgentPath: '/Users/bheng/Library/LaunchAgents/com.bheng.ok.plist' }), null);
});
