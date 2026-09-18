// macOS LaunchAgent (plist) creation + teardown. Extracted from server.js.
// Factory deps: username + launchAgentsDir (label/path), npmPath (npm resolution),
// xmlEscape (safe plist values), exec (execSync for launchctl unload).
const fs = require('fs');
const path = require('path');

// launchd execs ProgramArguments[0] directly: it never searches PATH, so a bare binary name
// ("node server.js") produces a plist that silently never starts. Resolve it against the same
// directories the plist exports as PATH.
const PLIST_PATH_DIRS = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
function resolveBin(bin) {
  if (bin.includes('/')) return bin;
  for (const d of PLIST_PATH_DIRS) { const full = path.join(d, bin); if (fs.existsSync(full)) return full; }
  return bin;   // unknown: let launchd report it rather than invent a path
}

module.exports = function makeLaunchd({ username, launchAgentsDir, npmPath, xmlEscape, exec, bootoutCmd }) {
  // Fail at construction, not inside the rewrite's catch, when a dependency is missing.
  for (const [k, v] of Object.entries({ username, launchAgentsDir, npmPath, xmlEscape, exec, bootoutCmd })) if (v === undefined) throw new Error(`lib/launchd.js: missing dependency ${k}`);
  function createLaunchAgent(id, localPath, logPath, startCommand) {
    if (!localPath) return { launchAgent: null, launchAgentPath: null };
    const label = `com.${username}.${id}`;
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    // Upsert: rewrite the plist when its arguments changed (a PUT that changes startCommand or path),
    // after booting the old service out so launchd reloads the new definition.
    const existing = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : null;

    const log = logPath || `/tmp/${id}.log`;
    // Default: "npm run dev", allow override e.g. "npm start", "bun dev".
    const cmd = startCommand || 'npm run dev';
    const parts = cmd.split(/\s+/);
    const bin = parts[0] === 'npm' ? npmPath : resolveBin(parts[0]);
    const args = parts.slice(1);
    const argsXml = [bin, ...args].map(a => `\t\t<string>${xmlEscape(a)}</string>`).join('\n');

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(label)}</string>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(localPath)}</string>
\t<key>ProgramArguments</key>
\t<array>
${argsXml}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xmlEscape(require('path').dirname(process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>KeepAlive</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(log)}</string>
</dict>
</plist>`;

    try {
      fs.mkdirSync(launchAgentsDir, { recursive: true });
      if (existing === plist) return { launchAgent: label, launchAgentPath: plistPath };
      if (existing !== null) { try { exec(bootoutCmd(process.getuid(), label)); } catch { /* not loaded */ } }
      fs.writeFileSync(plistPath, plist, 'utf8');
      return { launchAgent: label, launchAgentPath: plistPath };
    } catch { return { launchAgent: null, launchAgentPath: null }; }
  }

  function removeLaunchAgent(id) {
    const label = `com.${username}.${id}`;
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    try {
      exec(`launchctl unload "${plistPath}" 2>/dev/null || true`);
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    } catch { /* best effort */ }
  }

  return { createLaunchAgent, removeLaunchAgent };
};
