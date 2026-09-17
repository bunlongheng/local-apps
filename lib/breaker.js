// Circuit-breaker policy for the auto-restart escalation chain (pure, no I/O).
// The chain is L1, L1, L2, L3, L4 = 5 attempts over ~5 min; the breaker only trips
// once the whole chain has run (or the app crash-loops), and a breaker OFF is never
// permanent: it re-arms when the port is observed up or after a cooldown.
const FLAP_WINDOW_MS = 120000;
const CHAIN_ATTEMPTS = 5;
const EXHAUST_GRACE_MS = 300000; // let the last attempt (L4 agent) work for 5 min
const REARM_MS = 30 * 60000;

function pruneFlaps(s, now) {
  s.flapWindow = (s.flapWindow || []).filter(t => now - t < FLAP_WINDOW_MS);
  return s.flapWindow.length;
}

// Trip on 3 crashes-after-restart in 2 min, or the chain exhausted and still down.
function shouldTrip(s, now) {
  const flaps = pruneFlaps(s, now);
  const attempts = s.restartAttempts || 0;
  return flaps >= 3 || (attempts >= CHAIN_ATTEMPTS && now - (s.lastRestart || 0) > EXHAUST_GRACE_MS);
}

// Only a breaker OFF re-arms (a user OFF is a choice). Returns the reason or null.
function rearmReason(app, up, now) {
  if (!app.disabled || app.disabledReason !== 'breaker') return null;
  if (up) return 'observed up';
  if (now - (Date.parse(app.disabledAt) || 0) > REARM_MS) return 'cooldown elapsed';
  return null;
}

module.exports = { shouldTrip, rearmReason, FLAP_WINDOW_MS, CHAIN_ATTEMPTS, EXHAUST_GRACE_MS, REARM_MS };
