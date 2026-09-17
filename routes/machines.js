// Peer machines: discovery sweep, machine routes, remote apps, startup sync.
// Registered by server.js as require('./routes/machines')(app, ctx). Everything a handler needs comes
// from ctx, so this file has no module-level state beyond what it declares itself.
const os = require('os');

const REQUIRED = ['appRecord', 'db', 'dbg', 'fetchJson', 'sweepSubnet', 'peerRecord', 'IS_HUB', 'IS_MAIN', 'MACHINE_ROLE', 'PORT'];

module.exports = function register(app, ctx) {
  // Fail at boot, not at request time, when server.js forgets to pass a dependency.
  for (const k of REQUIRED) if (!(k in ctx)) throw new Error(`routes/machines.js: ctx is missing ${k}`);
  const { appRecord, db, dbg, fetchJson, sweepSubnet, peerRecord, IS_HUB, IS_MAIN, MACHINE_ROLE, PORT } = ctx;

  // --- Machines (peers) — auto-discovery ---
  let discoveredPeers = []; // live peers found on network

  function probeHost(ip, port = 9875) {
    return fetchJson(`http://${ip}:${port}/api/machine`, 2000)
      .then((info) => peerRecord(ip, port, info))
      .catch(() => null);
  }

  async function discoverPeers() {
    // Hub-only: an agent machine has no business sweeping the LAN every 30s.
    if (!IS_HUB || ctx.LAN_IP() === 'N/A') return;
    discoveredPeers = await sweepSubnet(ctx.LAN_IP(), probeHost, { concurrency: 32 });
    // Sync to DB
    for (const p of discoveredPeers) {
      db.upsertMachine(p);
    }
    // Remove stale machines no longer on network
    const liveIps = new Set(discoveredPeers.map(p => p.ip));
    for (const m of db.getMachines()) {
      if (!liveIps.has(m.ip)) {
        db.deleteMachine(m.id);
        db.deleteRemoteApps(m.id);
      }
    }
    // Fetch and store apps from each peer
    for (const p of discoveredPeers) {
      try {
        const data = await fetchJson(`http://${p.ip}:${p.port || 9875}/api/status`, 3000);
        if (data.apps && Array.isArray(data.apps)) {
          db.syncRemoteApps(p.id, data.apps);
        }
      } catch (e) { dbg('machines', e); }
    }
  }

  // Discover on boot + every 30s
  if (IS_MAIN) {
    discoverPeers();
    setInterval(discoverPeers, 30000);
  }

  app.get('/api/machines', (req, res) => {
    res.json(db.getMachines());
  });

  // All apps from all machines (local + remote, stored in DB)
  app.get('/api/all-apps', (req, res) => {
    const local = db.getApps().map(a => ({ ...a, machineId: 'local', machine: os.hostname() }));
    const remote = db.getRemoteApps().map(r => ({
      id: r.id, name: r.name, healthUrl: r.health_url, localUrl: r.local_url,
      caddyUrl: r.caddy_url, prodUrl: r.prod_url, repo: r.repo, icon: r.icon,
      status: r.status, machineId: r.machine_id, syncedAt: r.synced_at,
    }));
    res.json({ local, remote, total: local.length + remote.length });
  });

  // Remote apps for a specific machine
  app.get('/api/machines/:id/apps', (req, res) => {
    const apps = db.getRemoteApps(req.params.id);
    res.json(apps.map(r => ({
      id: r.id, name: r.name, healthUrl: r.health_url, localUrl: r.local_url,
      caddyUrl: r.caddy_url, prodUrl: r.prod_url, repo: r.repo, icon: r.icon,
      status: r.status, syncedAt: r.synced_at,
    })));
  });

  // Proxy: fetch remote machine's /api/status server-side (avoids CORS)
  app.get('/api/machines/:id/status', async (req, res) => {
    const m = db.getMachines().find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'machine not found' });
    const url = `http://${m.ip}:${m.port || 9875}/api/status`;
    try {
      const data = await fetchJson(url, 5000);
      const hostname = data.apps?.[0]?.hostname || m.hostname;
      const model = data.machineModel || m.model;
      db.upsertMachine({ id: m.id, hostname, ip: m.ip, port: m.port, model });
      // Only sanitised app records leave this hub; the peer's raw document is never proxied.
      res.json({ apps: (data.apps || []).map(appRecord).filter(Boolean), machineModel: String(data.machineModel || '').slice(0, 40), lanIp: String(data.lanIp || '').slice(0, 45) });
    } catch (err) {
      res.status(502).json({ error: `unreachable: ${err.message}` });
    }
  });

  // Identity: who is this machine? Peers read this server-side (http.get, no CORS needed), so
  // no wildcard Access-Control-Allow-Origin here - it only let a LAN browser snoop machine identity.
  app.get('/api/machine', (req, res) => {
    res.json({
      hostname: os.hostname(),
      model: ctx.MACHINE_MODEL(),
      role: MACHINE_ROLE,
      lanIp: ctx.LAN_IP(),
      port: PORT,
      appCount: db.getApps().length,
    });
  });

  // --- Startup: ping known machines to update last_seen ---
  async function startupSync() {
    const machines = db.getMachines();
    for (const m of machines) {
      try {
        const info = await fetchJson(`http://${m.ip}:${m.port || 9875}/api/machine`, 3000);
        db.upsertMachine({ id: m.id, hostname: info.hostname || m.hostname, ip: m.ip, port: m.port, model: info.model || m.model });
        console.log(`  Online: ${info.hostname || m.ip} (${info.appCount} apps)`);
      } catch {
        // unreachable — skip silently
      }
    }
  }

  return { startupSync };
};
