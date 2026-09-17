// The L1-L3 executor: turns a level from lib/escalation.js into commands. Every side effect
// comes through deps so tests/unit/chain.test.js can assert exactly what each level runs.
//   deps: { exec(cmd, opts) -> Promise<{stdout}>, killPort(port), exists(path), log(msg), warn(msg), startCmd, bootoutCmd,
//           spawn, openLog(path) -> fd, agent: boolean }   (the last 3 only for L4)
async function runLevel(level, { id, uid, label, plistPath, port, dir, logPath, downMs = 0 }, deps) {
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
  } else if (level === 4) {
    // Last resort: hand the failure to the local agent. Opt-in only (`agent: true` in
    // data/auto-restart.json), argv not a shell string, and a tool allowlist instead of
    // --dangerously-skip-permissions: the prompt embeds app-derived text, and the agent runs
    // inside a directory the hub does not control.
    if (!dir || !exists(dir)) return;
    if (!deps.agent) { log(`  [L4] agent disabled (set "agent": true in data/auto-restart.json): ${id}`); return; }
    log(`  [L4] deploying agent: ${id}`);
    const prompt = `The app "${id}" at ${dir} has been down for ${Math.round(downMs / 60000)} minutes. `
      + `Port: ${port || '?'}. LaunchAgent: ${label}. `
      + `Read the last 50 lines of ${logPath}, diagnose the issue, fix it, then run: `
      + `${startCmd(uid, label, plistPath)} `
      + `Wait 10s, verify http://localhost:${port} returns 200. If not, try harder.`;
    // Exact command shapes, not prefixes: launchctl:* would allow bootstrapping any plist and
    // curl:* is an exfil channel. --max-turns bounds a runaway session.
    const allowed = ['Read', 'Grep', 'Glob',
      `Bash(${startCmd(uid, label, plistPath)})`, `Bash(launchctl bootstrap gui/${uid} ${plistPath})`,
      'Bash(npm install --ignore-scripts)', `Bash(curl -s http://localhost:${port}*)`, `Bash(tail -50 ${logPath})`].join(',');
    const args = ['-p', prompt, '--allowedTools', allowed, '--max-turns', '25'];
    try {
      const out = deps.openLog(logPath);
      deps.spawn('claude', args, { cwd: dir, detached: true, stdio: ['ignore', out, out] }).unref();
    } catch (e) { warn(`  [L4] could not start agent for ${id}: ${e.message}`); }
  }
}

module.exports = { runLevel };
