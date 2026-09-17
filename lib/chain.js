// The L1-L3 executor: turns a level from lib/escalation.js into commands. Every side effect
// comes through deps so tests/unit/chain.test.js can assert exactly what each level runs.
//   deps: { exec(cmd, opts) -> Promise<{stdout}>, killPort(port), exists(path), log(msg), warn(msg), startCmd, bootoutCmd }
async function runLevel(level, { id, uid, label, plistPath, port, dir, logPath }, deps) {
  const { exec, killPort, exists, log, warn, startCmd, bootoutCmd } = deps;
  if (level === 1) {
    await exec(startCmd(uid, label, plistPath), { timeout: 15000 });
    log(`  [L1] kickstart: ${id}`);
  } else if (level === 2) {
    if (port) await killPort(port);
    await exec(`${bootoutCmd(uid, label)}; sleep 1; launchctl bootstrap gui/${uid} "${plistPath}" 2>/dev/null`, { timeout: 15000 });
    log(`  [L2] port-kill + reload: ${id}`);
  } else if (level === 3) {
    if (dir && exists(dir)) {
      let logTail = '';
      try { logTail = (await exec(`tail -30 "${logPath}" 2>/dev/null`, { timeout: 5000 })).stdout; } catch { logTail = ''; }
      const fixes = require('./escalation').l3Fixes(logTail);
      if (fixes.npmInstall) {
        log(`  [L3] npm install: ${id}`);
        // --ignore-scripts: a registered app dir is attacker-influencable; never run its lifecycle scripts.
        try { await exec(`cd "${dir}" && npm install --ignore-scripts 2>/dev/null`, { timeout: 60000 }); } catch (e) { warn(`  [L3] npm install failed: ${id}: ${e.message}`); }
      }
      if (fixes.clearNext) {
        log(`  [L3] clear .next cache: ${id}`);
        try { await exec(`rm -rf "${dir}/.next" 2>/dev/null`, { timeout: 5000 }); } catch (e) { warn(`  [L3] clear .next failed: ${id}: ${e.message}`); }
      }
      if (port) await killPort(port);
    }
    await exec(startCmd(uid, label, plistPath), { timeout: 15000 });
    log(`  [L3] fix + restart: ${id}`);
  }
}

module.exports = { runLevel };
