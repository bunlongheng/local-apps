// Auto-restart escalation policy, pure: given the app's health state and the clock, say
// which level fires now. server.js executes the level; this file never touches the shell,
// the DB or SSE, so every rule below is unit-tested in isolation (tests/unit/escalation.test.js).
//
//   L1  first attempt, or 1 retry after 60s          kickstart via launchctl
//   L2  attempts <= 2, down > 90s,  60s since last   kill the port, bootout + bootstrap
//   L3  attempts <= 3, down > 180s, 60s since last   log-driven fixes, then restart
//   L4  attempts <= 4, down > 300s, 120s since last  hand to the local agent (opt-in)
//   L5 (breaker) is decided before any of these by lib/breaker.js.
const RETRY_MS = 60000;
const L2_AFTER_MS = 90000, L3_AFTER_MS = 180000, L4_AFTER_MS = 300000, L4_RETRY_MS = 120000;

function nextLevel(state, now) {
  const attempts = state.restartAttempts || 0;
  const lastRestart = state.lastRestart || 0;
  const downFor = now - (state.downSince || now);
  const sinceLast = now - lastRestart;
  if (attempts === 0 || (attempts === 1 && sinceLast > RETRY_MS)) return 1;
  if (attempts <= 2 && downFor > L2_AFTER_MS && sinceLast > RETRY_MS) return 2;
  if (attempts <= 3 && downFor > L3_AFTER_MS && sinceLast > RETRY_MS) return 3;
  if (attempts <= 4 && downFor > L4_AFTER_MS && sinceLast > L4_RETRY_MS) return 4;
  return 0; // nothing fires this tick; the breaker exhausts the chain via lib/breaker.js
}

// Record that a level ran, whether or not its command succeeded: a failing launchctl
// used to skip the bookkeeping and retry the same level forever.
function recordAttempt(state, now) {
  state.lastRestart = now;
  state.restartAttempts = (state.restartAttempts || 0) + 1;
}

// Which log-driven fixes L3 applies, from the tail of the app log.
function l3Fixes(logTail) {
  const t = String(logTail || '');
  return {
    npmInstall: t.includes('Cannot find module') || t.includes('MODULE_NOT_FOUND'),
    clearNext: t.includes('.next') || t.includes('ENOENT') || t.includes('Build error'),
  };
}

module.exports = { nextLevel, recordAttempt, l3Fixes, RETRY_MS, L2_AFTER_MS, L3_AFTER_MS, L4_AFTER_MS, L4_RETRY_MS };
