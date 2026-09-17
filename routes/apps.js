// App routes: registry CRUD, toggle, bulk-toggle, events (SSE), log, start, stop, and the port helpers they share.
// Registered by server.js as require('./routes/apps')(app, ctx). Everything a handler needs comes
// from ctx, so this file has no module-level state beyond what it declares itself.
const fs = require('fs');

const REQUIRED = ['getNextAvailablePort', 'isPortTaken', 'killPort', 'db', 'dbg', 'broadcast', 'sseClients', 'getState', 'clearState', 'checkSingle', 'setupInfra', 'teardownInfra', 'updateTabColors', 'forViewer', 'startCmd', 'execAsync', 'execSync', 'spawn', 'validateAppFields', 'isValidId', 'isChromeExtensionRepo', 'CHROME_EXT_ERROR', 'addCaddyEntry', 'renameCaddyEntry'];

module.exports = function register(app, ctx) {
  // Fail at boot, not at request time, when server.js forgets to pass a dependency.
  for (const k of REQUIRED) if (!(k in ctx)) throw new Error(`routes/apps.js: ctx is missing ${k}`);
  const { getNextAvailablePort, isPortTaken, killPort, db, dbg, broadcast, sseClients, getState, clearState, checkSingle, setupInfra, teardownInfra, updateTabColors, forViewer, startCmd, execAsync, execSync, spawn, validateAppFields, isValidId, isChromeExtensionRepo, CHROME_EXT_ERROR, addCaddyEntry, renameCaddyEntry } = ctx;


  // --- CRUD: Apps ---
  app.get('/api/apps', (req, res) => {
    res.json(db.getApps().map(a => forViewer(req, a)));
  });

  app.get('/api/apps/:id', (req, res) => {
    const a = db.getApp(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    res.json(forViewer(req, a));
  });

  // Toggle app disabled state (excludes from auto-restart when disabled)
  app.post('/api/apps/:id/toggle', (req, res) => {
    const a = db.getApp(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    const newState = !a.disabled;
    db.setAppDisabled(a.id, newState);
    // If disabling, also stop the app
    if (newState && a.launchAgent) {
      const uid = process.getuid();
      try { execSync(`launchctl bootout gui/${uid}/${a.launchAgent} 2>/dev/null`, { timeout: 10000 }); } catch (e) { dbg('line526', e); }
      const s = getState(a.id);
      s.status = 'down';
      s.downSince = null;
      s.restartAttempts = 0;
      broadcast({ type: 'update', id: a.id, status: 'down' });
    }
    // If enabling, kick it back to life (bootstrap if the service isn't loaded in launchd)
    if (!newState && a.launchAgent) {
      const uid = process.getuid();
      try { execSync(startCmd(uid, a.launchAgent, a.launchAgentPath), { timeout: 15000 }); } catch (e) { dbg('line536', e); }
      setTimeout(() => checkSingle(a), 3000);
      setTimeout(() => checkSingle(a), 8000);
      setTimeout(() => checkSingle(a), 15000);
    }
    console.log(`  ${newState ? '⏸' : '▶'} ${a.id} ${newState ? 'disabled' : 'enabled'}`);
    res.json({ id: a.id, disabled: newState });
  });

  // Bulk toggle: disable all except specified IDs
  app.post('/api/apps/bulk-toggle', async (req, res) => {
    const jobs = [];
    const { keep = [] } = req.body || {};
    const apps = db.getApps();
    const uid = process.getuid();
    const results = [];
    for (const a of apps) {
      const shouldDisable = !keep.includes(a.id);
      const wasDisabled = a.disabled;
      db.setAppDisabled(a.id, shouldDisable);
      // Stop newly disabled apps
      if (shouldDisable && !wasDisabled && a.launchAgent) {
        jobs.push(execAsync(`launchctl bootout gui/${uid}/${a.launchAgent} 2>/dev/null`, { timeout: 10000 }).catch(() => {}));
        const s = getState(a.id);
        s.status = 'down';
        s.downSince = null;
        s.restartAttempts = 0;
        broadcast({ type: 'update', id: a.id, status: 'down' });
      }
      // Start newly enabled apps
      if (!shouldDisable && wasDisabled && a.launchAgent) {
        jobs.push(execAsync(startCmd(uid, a.launchAgent, a.launchAgentPath), { timeout: 15000 }).catch(() => {}));
      }
      results.push({ id: a.id, disabled: shouldDisable });
    }
    // launchctl calls run concurrently and awaited, never serial execSync on the event loop.
    await Promise.all(jobs);
    console.log(`  bulk-toggle: keeping ${keep.join(', ')}, disabled ${results.filter(r => r.disabled).length} apps`);
    res.json({ ok: true, results });
  });


  app.post('/api/apps', (req, res) => {
    const { id } = req.body;
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required (string)' });
    if (!isValidId(id)) return res.status(400).json({ error: 'id must be lowercase alphanumeric/hyphens, 1-64 chars' });
    if (req.body.name && typeof req.body.name !== 'string') return res.status(400).json({ error: 'name must be a string' });
    const vErr = validateAppFields(req.body);
    if (vErr) return res.status(400).json({ error: vErr });
    if (isChromeExtensionRepo(req.body.localPath)) return res.status(400).json({ error: CHROME_EXT_ERROR });

    // Check for port conflict if a port is specified
    const requestedUrl = req.body.localUrl || req.body.healthUrl;
    if (requestedUrl) {
      try {
        const requestedPort = parseInt(new URL(requestedUrl).port);
        const conflictApp = isPortTaken(requestedPort, id);
        if (conflictApp) {
          const suggested = getNextAvailablePort();
          return res.status(409).json({
            error: `Port ${requestedPort} is already used by "${conflictApp}"`,
            suggestedPort: suggested,
            suggestedUrl: suggested ? `http://localhost:${suggested}` : null
          });
        }
      } catch (e) { dbg('line617', e); }
    }

    // Auto-setup infra (caddy, hosts, launch agent)
    const infra = setupInfra(id, req.body);
    const merged = { ...req.body, ...infra };

    // Auto-set healthUrl from localUrl if not provided
    if (!merged.healthUrl && merged.localUrl) merged.healthUrl = merged.localUrl;

    const result = db.upsertApp(merged);
    // Extract assigned port for clear response
    let assignedPort = null;
    try { assignedPort = parseInt(new URL(result.localUrl).port); } catch (e) { dbg('line630', e); }
    broadcast({ type: 'reload' });
    res.status(201).json({ ...result, assignedPort });
  });

  app.put('/api/apps/:id', (req, res) => {
    const existing = db.getApp(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const vErr = validateAppFields(req.body);
    if (vErr) return res.status(400).json({ error: vErr });
    if (isChromeExtensionRepo(req.body.localPath)) return res.status(400).json({ error: CHROME_EXT_ERROR });

    // Check for port conflict on update
    const requestedUrl = req.body.localUrl || req.body.healthUrl;
    if (requestedUrl) {
      try {
        const requestedPort = parseInt(new URL(requestedUrl).port);
        const conflictApp = isPortTaken(requestedPort, req.params.id);
        if (conflictApp) {
          const suggested = getNextAvailablePort();
          return res.status(409).json({
            error: `Port ${requestedPort} is already used by "${conflictApp}"`,
            suggestedPort: suggested,
            suggestedUrl: suggested ? `http://localhost:${suggested}` : null
          });
        }
      } catch (e) { dbg('line657', e); }
    }

    // Re-setup infra if localUrl or localPath changed
    const data = { ...req.body, id: req.params.id };
    if (data.localUrl || data.localPath) {
      const infra = setupInfra(req.params.id, { ...existing, ...data });
      Object.assign(data, infra);
    }

    // Sync tab-colors label when name changes
    if (data.name && data.name !== existing.name) {
      updateTabColors(req.params.id, data.name, data.caddyUrl || existing.caddyUrl);
    }

    // Sync Caddy hostname when caddyUrl changes
    if (data.caddyUrl && data.caddyUrl !== existing.caddyUrl) {
      const port = (() => { try { return new URL(data.localUrl || existing.localUrl).port; } catch { return null; } })();
      if (port) {
        // Extract new hostname from caddyUrl
        const newHost = data.caddyUrl.replace(/^https?:\/\//, '').replace(/\.localhost.*/, '');
        const oldHost = (existing.caddyUrl || '').replace(/^https?:\/\//, '').replace(/\.localhost.*/, '');
        if (newHost !== oldHost && oldHost) {
          renameCaddyEntry(oldHost, newHost, port);
        } else if (!oldHost) {
          addCaddyEntry(newHost, port);
        }
      }
    }

    const result = db.upsertApp(data);
    broadcast({ type: 'reload' });
    res.json(result);
  });

  app.delete('/api/apps/:id', async (req, res) => {
    const a = db.getApp(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    await teardownInfra(a);          // kill the process and unload the agent while the record still exists
    db.deleteApp(req.params.id);
    clearState(req.params.id);
    broadcast({ type: 'update', id: req.params.id, status: 'removed' });
    res.json({ ok: true });
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    res.on('close', () => sseClients.delete(res));
  });

  app.get('/api/log/:id', (req, res) => {
    const appCfg = db.getApp(req.params.id);
    if (!appCfg) return res.status(404).json({ error: 'not found' });
    if (!appCfg.logPath) return res.json({ lines: [] });
    // Async, bounded tail (last 64KB) - no shell, does not block the event loop.
    const MAX = 64 * 1024;
    fs.open(appCfg.logPath, 'r', (err, fd) => {
      if (err) return res.json({ lines: [] });
      fs.fstat(fd, (e2, st) => {
        if (e2) { fs.close(fd, () => {}); return res.json({ lines: [] }); }
        const start = Math.max(0, st.size - MAX);
        const buf = Buffer.alloc(st.size - start);
        fs.read(fd, buf, 0, buf.length, start, () => {
          fs.close(fd, () => {});
          const lines = buf.toString('utf8').trimEnd().split('\n').filter(Boolean);
          res.json({ lines: lines.slice(-30) });
        });
      });
    });
  });

  app.post('/api/start/:id', (req, res) => {
    const appCfg = db.getApp(req.params.id);
    if (!appCfg) return res.status(404).json({ error: 'not found' });
    if (!appCfg.launchAgent) return res.status(400).json({ error: 'no launchAgent configured' });
    try {
      const uid = process.getuid();
      const label = appCfg.launchAgent;
      const plist = appCfg.launchAgentPath;
      // Kickstart in background (non-blocking), respond immediately; bootstrap if not loaded
      spawn('bash', ['-c', startCmd(uid, label, plist)], { detached: true, stdio: 'ignore' }).unref();
      // Recheck health at 3s, 8s, 15s so UI updates fast
      setTimeout(() => checkSingle(appCfg), 3000);
      setTimeout(() => checkSingle(appCfg), 8000);
      setTimeout(() => checkSingle(appCfg), 15000);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/stop/:id', (req, res) => {
    const appCfg = db.getApp(req.params.id);
    if (!appCfg) return res.status(404).json({ error: 'not found' });
    if (!appCfg.launchAgent) return res.status(400).json({ error: 'no launchAgent configured' });
    try {
      const uid = process.getuid();
      const label = appCfg.launchAgent;
      const port = appCfg.localUrl ? (() => { try { return new URL(appCfg.localUrl).port; } catch { return null; } })() : null;
      // Kill port first (instant), then bootout in background
      if (port) killPort(port);
      spawn('bash', ['-c', `launchctl bootout gui/${uid}/${label} 2>/dev/null`], { detached: true, stdio: 'ignore' }).unref();
      // Update status immediately
      const s = getState(appCfg.id);
      s.status = 'down';
      broadcast({ type: 'update', id: appCfg.id, status: 'down' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
