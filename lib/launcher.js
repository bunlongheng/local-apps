// Launcher feed for the companion Chrome extension (bunlongheng/local-apps-launcher).
//
// Only apps with a HOSTED url are launchable without starting anything locally, so
// that is the filter. A Tailscale url is the local port over the tailnet and only
// works while the app is up, so `tail` is attached only to apps that are up right
// now; the extension re-syncs every 30 minutes and tracks reality.
//
// The document is deliberately minimal (no paths, plists, logs, ports) because it
// leaves the machine via chrome.storage.sync. `version` is a content hash so a client
// can skip the write when nothing changed.
const crypto = require('crypto');

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

function buildLauncher(apps, { tailscaleIp = null, stateOf = () => ({}) } = {}) {
  const out = [];
  for (const a of apps) {
    if (!a.prodUrl && !a.prodUrl2) continue;
    const urls = {};
    if (a.prodUrl) urls.prod = a.prodUrl;
    if (a.prodUrl2) urls.prod2 = a.prodUrl2;
    if (a.repo) urls.repo = a.repo;
    const up = stateOf(a.id).status === 'up';
    if (up && tailscaleIp && a.localUrl) urls.tail = a.localUrl.replace('localhost', tailscaleIp);
    const aliases = [...new Set([a.id, (a.name || '').toLowerCase()].filter(Boolean))];
    out.push({
      id: a.id,
      name: a.name || a.id,
      aliases,
      host: hostOf(a.prodUrl || a.prodUrl2),
      color: a.tabColor || null,
      icon: a.tabIcon || null,
      urls,
    });
  }
  out.sort((x, y) => x.name.localeCompare(y.name));
  const version = crypto.createHash('sha1').update(JSON.stringify(out)).digest('hex').slice(0, 12);
  return { version, generatedAt: new Date().toISOString(), apps: out };
}

module.exports = { buildLauncher };
