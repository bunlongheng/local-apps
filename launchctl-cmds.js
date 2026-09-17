// launchctl command builders shared by the app start paths (toggle-ON,
// /api/start, auto-restart L1). kickstart only works on services loaded in
// launchd; after the 2026-06-04 LaunchAgent purge most services are booted
// out, so every start MUST fall back to bootstrapping the plist or the app
// silently stays down (kickstart exits 113, stderr discarded).
//
// The purge also ran `launchctl disable`, and a disabled label cannot be
// bootstrapped at all - it fails with "Bootstrap failed: 5: Input/output
// error". So the fallback has to enable the label first. And because most
// plists carry RunAtLoad=false, bootstrap only loads the job; a kickstart
// after it is what actually starts the process.
//
// Enabling here is safe: auto-restart is gated on !appCfg.disabled and the
// toggle paths only run on explicit user action, so an intentionally
// disabled app is never reached by this command.
function startCmd(uid, label, plistPath) {
  return `launchctl kickstart -k gui/${uid}/${label} 2>/dev/null || `
    + `{ launchctl enable gui/${uid}/${label} 2>/dev/null; `
    + `launchctl bootstrap gui/${uid} "${plistPath}" 2>/dev/null; `
    + `launchctl kickstart gui/${uid}/${label} 2>/dev/null; }`;
}

module.exports = { startCmd };
