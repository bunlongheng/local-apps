# local-apps - Local app hub/monitor (port 9875, local-apps.localhost)

## What this is
Self-healing, multi-machine orchestrator that monitors and auto-fixes local web apps. Hub + Agent architecture: the hub (a Mac Mini) runs the bots; agent machines only report status.

## Run
- One service: Express (`node server.js`) serves the dashboard UI (static `public/`) AND the control API on port 9875. No framework, no build step.
- Dev (watch mode): `npm run dev` (= `node --watch server.js`); prod: `npm run start`
- launchd runs `start.sh` (`exec node server.js`); KeepAlive is the watchdog.

## Architecture rules
- Apps register via POST /api/apps - auto-assigns a port, a Caddy reverse proxy, and a macOS LaunchAgent.
- Machine role set via machine-role.json or the MACHINE_ROLE env var (hub or agent).
- SQLite (better-sqlite3) stores apps, machines, and remote_apps tables.

## Auth model
- The control API fails closed off-box: loopback is fully trusted; any non-localhost caller is denied all mutations and sensitive (log) reads unless it presents `x-local-apps-token`. Policy lives in `lib/auth-gate.js` (pure + unit-tested).

## Restart mechanisms (two independent - check both if an app you stopped respawns)
- launchd `KeepAlive=true` in the app's `~/Library/LaunchAgents/*.plist` respawns a killed process instantly. A plain kill is useless - use `launchctl bootout` + `launchctl disable` to truly stop it.
- Dashboard auto-restart in server.js `checkAll()` kickstarts any "down" app every 30s, gated by `data/auto-restart.json`.

## Key API endpoints
- GET/POST /api/apps, PUT/DELETE /api/apps/:id, GET /api/status, POST /api/start/:id, POST /api/stop/:id
- GET /api/machines, GET /api/machines/:id/status, GET /api/machines/:id/apps
- GET /api/events (SSE), GET /api/log/:id

## Tests
- `npm test` (unit + e2e), `npm run test:unit` (CI gate, coverage threshold), `npm run test:e2e` (needs a live :9875)
