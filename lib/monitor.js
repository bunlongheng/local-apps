// The monitor tick: probe every app, let lib/tick.js decide, execute the decision. Every side
// effect (db, shell, SSE, clock) comes through deps so tests/unit/monitor.test.js drives the
// breaker, re-arm and level paths without a host.
//   deps: { getApps, setAppDisabled, probe(app) -> Promise<bool>, getState, decide, runLevel, recordAttempt,
//           readAutoRestart() -> {enabled, agent}, hub, uid, logDir, killPort, exec, bootoutCmd, startCmd,
//           spawn, openLog, exists, broadcast, log, warn, dbg, now }
const path = require('path');

const portOf = (url) => { try { return new URL(url).port || null; } catch { return null; } };

module.exports = function makeMonitor(deps) {
  const { getApps, setAppDisabled, probe, getState, decide, runLevel, recordAttempt, readAutoRestart, hub, uid, logDir,
    killPort, exec, bootoutCmd, startCmd, spawn, openLog, exists, broadcast, log, warn, dbg, now } = deps;
  let running = false;

  async function checkAll() {
    // Re-entrancy guard: a slow tick can outlast the interval; overlapping runs would stack
    // restart attempts. Skip a tick if the previous one is still in flight.
    if (running) return false;
    running = true;
    try {
      const apps = getApps();
      // Probe concurrently (independent reads); the escalation loop below stays sequential on
      // purpose: it shells out, and 65 concurrent `npm install`s would be worse than a slow tick.
      const probes = await Promise.all(apps.map(probe));
      // Read once per tick, not once per app: 2 booleans that cannot change mid-tick.
      const cfg = readAutoRestart();
      const autoRestart = !!cfg.enabled;
      const agent = cfg.agent === true;
      for (const [index, app] of apps.entries()) {
        const s = getState(app.id);
        const t = now();
        s.lastChecked = new Date(t).toISOString();
        // L1 kickstart, L2 port-kill + reload, L3 log-driven fixes, L4 agent (opt-in), L5 breaker
        // and re-arm: which fires is decided by lib/tick.js; this loop only executes it.
        const d = decide({ s, app, up: probes[index], now: t, hub, autoRestart });
        if (d.changed) {
          broadcast({ type: 'update', id: app.id, status: d.status });
          if (d.status === 'down') broadcast({ type: 'alert', id: app.id, name: app.name });
        }
        if (d.rearm) {
          setAppDisabled(app.id, false);
          app.disabled = false;
          log(`  [L5] re-armed ${app.id} (${d.rearm})`);
          broadcast({ type: 'update', id: app.id, status: d.status, disabled: false });
        }
        if (d.recovered && d.recovered.attempts > 0) log(`  ✓ recovered: ${app.id} (after ${d.recovered.attempts} attempts, ${Math.round(d.recovered.downMs / 1000)}s)`);
        if (!d.trip && !d.level) continue;

        const label = app.launchAgent, plistPath = app.launchAgentPath;
        const port = app.localUrl ? portOf(app.localUrl) : null;
        if (d.trip) {
          // Independent: a failed port kill must not skip the bootout, or the service stays loaded
          // while the row says OFF.
          try { if (port) await killPort(port); } catch (e) { dbg('checkAll/killPort', e); }
          try { if (label) await exec(bootoutCmd(uid, label), { timeout: 10000 }); } catch (e) { dbg('checkAll/bootout', e); }
          setAppDisabled(app.id, true, 'breaker');
          app.disabled = true;
          log(`  [L5] circuit breaker -> disabled ${app.id} (${d.trip.flaps} flaps, ${d.trip.attempts} attempts)`);
          broadcast({ type: 'update', id: app.id, status: 'down', disabled: true });
          broadcast({ type: 'alert', id: app.id, name: app.name, disabled: true });
          continue;
        }
        // Every level records the attempt before running its command.
        recordAttempt(s, t);
        try {
          await runLevel(d.level, { id: app.id, uid, label, plistPath, port, dir: app.localPath, logPath: app.logPath || path.join(logDir, `${app.id}.log`), downMs: t - s.downSince },
            { exec, killPort, exists, log, warn, startCmd, bootoutCmd, spawn, agent, openLog });
        } catch (e) { dbg(`L${d.level}`, e); }
      }
      return true;
    } finally { running = false; }
  }

  return { checkAll };
};

// The scheduled form of a tick: a rejection is reported through warn, never left unhandled (an
// unhandled rejection ends the process and launchd spins it).
module.exports.guardedTick = function guardedTick(checkAll, warn) {
  return () => checkAll().catch((e) => warn(`  checkAll failed: ${e && e.message ? e.message : e}`));
};
