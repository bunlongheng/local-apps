// Provisioning: port allocation plus the Caddy block and LaunchAgent an app gets on POST/PUT and
// loses on DELETE. Every host effect comes through deps so tests/unit/infra.test.js can run the
// darwin branch on any OS (CI is ubuntu, where canProvision is false in production).
//   deps: { canProvision, getApps, addCaddyEntry, removeCaddyEntry, createLaunchAgent, removeLaunchAgent,
//           killPort, exec, bootoutCmd, uid, logDir, dbg, log }
const path = require('path');

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 9875; // below monitor port

const portOf = (url) => { try { return parseInt(new URL(url).port) || null; } catch { return null; } };
// A PUT may have renamed the Caddy host; the record's caddyUrl is the block that really exists.
const hostOf = (caddyUrl) => String(caddyUrl || '').replace(/^https?:\/\//, '').replace(/\.localhost.*$/, '');

module.exports = function makeInfra(deps) {
  const { canProvision, getApps, addCaddyEntry, removeCaddyEntry, createLaunchAgent, removeLaunchAgent, killPort, exec, bootoutCmd, uid, logDir, dbg, log } = deps;

  // Both localUrl and healthUrl count: a healthUrl-only app still owns its port.
  function isPortTaken(port, excludeId) {
    for (const a of getApps()) {
      if (excludeId && a.id === excludeId) continue;
      for (const u of [a.localUrl, a.healthUrl]) if (u && portOf(u) === port) return a.id;
    }
    return null;
  }

  function getNextAvailablePort() {
    const used = new Set();
    for (const a of getApps()) for (const u of [a.localUrl, a.healthUrl]) { const p = u && portOf(u); if (p) used.add(p); }
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) if (!used.has(p)) return p;
    return null;
  }

  // Caddy proxies and LaunchAgents are host features of a Homebrew macOS box. Anywhere else the
  // dashboard and API run in monitoring mode, exactly as the README promises.
  function setupInfra(id, data) {
    const result = {};
    let port = (data.localUrl && portOf(data.localUrl)) || (data.healthUrl && portOf(data.healthUrl)) || null;
    if (!port) {
      port = getNextAvailablePort();
      if (port) { result.localUrl = `http://localhost:${port}`; result.healthUrl = `http://localhost:${port}`; }
    }
    if (!canProvision) return result;
    if (port) result.caddyUrl = addCaddyEntry(id, port);
    if (data.localPath) {
      const logPath = data.logPath || path.join(logDir, `${id}.log`);
      const la = createLaunchAgent(id, data.localPath, logPath, data.startCommand);
      result.launchAgent = la.launchAgent;
      result.launchAgentPath = la.launchAgentPath;
      result.logPath = logPath;
    }
    return result;
  }

  // Takes the record, not the id: DELETE calls this before the row is gone, so the port is known.
  async function teardownInfra(app) {
    const id = typeof app === 'string' ? app : app.id;
    try { const port = app && app.localUrl ? portOf(app.localUrl) : null; if (port) await killPort(port); } catch (e) { dbg('teardown/killPort', e); }
    if (!canProvision) return;
    if (app && app.launchAgent) { try { await exec(bootoutCmd(uid, app.launchAgent), { timeout: 10000 }); } catch (e) { dbg('teardown/bootout', e); } }
    const host = (app && app.caddyUrl && hostOf(app.caddyUrl)) || id;
    removeCaddyEntry(host);
    if (host !== id) removeCaddyEntry(id);
    removeLaunchAgent(id);
    log(`  cleanup: ${id}`);
  }

  return { isPortTaken, getNextAvailablePort, setupInfra, teardownInfra, PORT_RANGE_START, PORT_RANGE_END };
};
