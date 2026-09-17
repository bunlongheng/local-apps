// The per-app health decision for one monitor tick, pure: it reads and updates the in-memory
// state `s` (status, flap window, counters) and says what checkAll must execute - a broadcast,
// a re-arm, a breaker trip, or an escalation level. It never touches the db, the shell, SSE
// or the network, so every transition is unit-tested in tests/unit/tick.test.js.
const { shouldTrip, rearmReason, FLAP_WINDOW_MS } = require('./breaker');
const { nextLevel } = require('./escalation');

function decide({ s, app, up, now, hub, autoRestart }) {
  const status = up ? 'up' : 'down';
  const changed = s.status !== status;
  if (changed) {
    // Going down shortly after a restart means it crashed on us. Tracked in a rolling window
    // that survives the 'up' counter reset below, so a start-then-crash app can't loop forever.
    if (status === 'down' && s.status === 'up' && s.lastRestart && now - s.lastRestart < FLAP_WINDOW_MS) {
      s.flapWindow = (s.flapWindow || []).filter(t => now - t < FLAP_WINDOW_MS);
      s.flapWindow.push(now);
    }
    s.status = status;
  }
  const chain = !!(hub && autoRestart);
  // L5 recovery: a breaker OFF (never a user OFF) re-arms when the port is observed up or
  // after the cooldown, so a healthy app can't sit grey forever.
  const rearm = chain ? rearmReason(app, up, now) : null;
  if (rearm) { s.downSince = null; s.restartAttempts = 0; s.flapWindow = []; }

  let trip = null, level = 0;
  const eligible = chain && status === 'down' && (!app.disabled || rearm) && !!(app.launchAgentPath || app.launchAgent);
  if (eligible) {
    if (!s.downSince) s.downSince = now;
    // The breaker runs before L1 so it intercepts; once disabled the app is skipped until re-arm.
    if (shouldTrip(s, now)) {
      trip = { flaps: s.flapWindow.length, attempts: s.restartAttempts || 0 };
      s.downSince = null; s.restartAttempts = 0; s.flapWindow = [];
    } else level = nextLevel(s, now);
  }

  let recovered = null;
  if (status === 'up' && s.downSince) {
    recovered = { attempts: s.restartAttempts || 0, downMs: now - s.downSince };
    s.downSince = null; s.restartAttempts = 0;
  }
  return { status, changed, rearm, trip, level, recovered };
}

module.exports = { decide };
