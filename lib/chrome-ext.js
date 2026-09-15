// Chrome extension guard. A browser extension is not a monitorable app: it has no
// server, no port and no uptime, so onboarding one buys a Caddy host, a LaunchAgent,
// an auto-restart slot and a screenshot run for a green dot that means nothing.
// The control API refuses them - see server.js POST/PUT /api/apps.
const fs = require('fs');
const path = require('path');

// True when the manifest.json text is a Chrome/Edge extension manifest (MV2/MV3).
// A PWA web app manifest (public/manifest.json) has no manifest_version, so it passes.
function isChromeExtensionManifest(text) {
  try {
    const m = JSON.parse(text);
    return !!m && typeof m === 'object' && typeof m.manifest_version === 'number';
  } catch {
    return false;
  }
}

// True when localPath is the root of a Chrome extension repo. Only the repo root is
// checked - public/manifest.json and dist/manifest.json belong to web apps and builds.
function isChromeExtensionRepo(localPath, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  if (!localPath || typeof localPath !== 'string') return false;
  try {
    return isChromeExtensionManifest(readFile(path.join(localPath, 'manifest.json')));
  } catch {
    return false;
  }
}

const CHROME_EXT_ERROR = 'Chrome extensions are not onboarded here: this dashboard monitors HTTP services, and an extension has no port to health-check. Load it unpacked in Chrome and use the repo\'s own extension tests instead.';

module.exports = { isChromeExtensionManifest, isChromeExtensionRepo, CHROME_EXT_ERROR };
