// macOS LaunchAgent (plist) creation + teardown. Extracted from server.js.
// Factory deps: username + launchAgentsDir (label/path), npmPath (npm resolution),
// xmlEscape (safe plist values), exec (execSync for launchctl unload).
const fs = require('fs');
const path = require('path');

module.exports = function makeLaunchd({ username, launchAgentsDir, npmPath, xmlEscape, exec }) {
  function createLaunchAgent(id, localPath, logPath, startCommand) {
    if (!localPath) return { launchAgent: null, launchAgentPath: null };
    const label = `com.${username}.${id}`;
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    if (fs.existsSync(plistPath)) return { launchAgent: label, launchAgentPath: plistPath };

    const log = logPath || `/tmp/${id}.log`;
    // Default: "npm run dev", allow override e.g. "npm start", "bun dev".
    const cmd = startCommand || 'npm run dev';
    const parts = cmd.split(/\s+/);
    const bin = parts[0] === 'npm' ? npmPath : parts[0];
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
\t\t<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
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
