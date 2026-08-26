// launchctl command builders shared by the app start paths (toggle-ON,
// /api/start, auto-restart L1). kickstart only works on services loaded in
// launchd; after the 2026-06-04 LaunchAgent purge most services are booted
// out, so every start MUST fall back to bootstrapping the plist or the app
// silently stays down (kickstart exits 113, stderr discarded).
function startCmd(uid, label, plistPath) {
  return `launchctl kickstart -k gui/${uid}/${label} 2>/dev/null || launchctl bootstrap gui/${uid} "${plistPath}" 2>/dev/null`;
}

module.exports = { startCmd };
