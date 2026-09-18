// Unit: the lint rule that guards app start paths. Every start must go through startCmd() in
// launchctl-cmds.js; an inline launchctl kickstart or bootstrap anywhere else is an error.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ESLint } = require('eslint');

const ROOT = path.join(__dirname, '..', '..');
const lint = async (code, file) => (await new ESLint({ cwd: ROOT }).lintText(code, { filePath: path.join(ROOT, file) }))[0];

test('an inline kickstart or bootstrap in a start path is a lint error; launchctl-cmds.js may spell them', async () => {
  const kick = await lint('const u = 1, l = "x"; module.exports = `launchctl kickstart -k gui/${u}/${l}`;\n', 'routes/x.js');
  assert.equal(kick.errorCount, 1); assert.match(kick.messages[0].message, /startCmd\(\)/);
  const boot = await lint('module.exports = "launchctl bootstrap gui/1 \\"p\\"";\n', 'lib/x.js');
  assert.equal(boot.errorCount, 1);
  const plain = await lint('module.exports = "launchctl kickstart gui/1/x";\n', 'server.js');
  assert.equal(plain.errorCount, 1, 'a kickstart without -k is still an inline start');
  const allowed = await lint('module.exports = `launchctl kickstart -k gui/${1}/x || launchctl bootstrap gui/1 "p"`;\n', 'launchctl-cmds.js');
  assert.equal(allowed.errorCount, 0);
  const cron = await lint('module.exports = "launchctl list";\n', 'routes/x.js');
  assert.equal(cron.errorCount, 0, 'other launchctl verbs are fine');
});
