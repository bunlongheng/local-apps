# local-apps - Local app hub/monitor (port 9875, local-apps.localhost)

## What this is
Self-healing, multi-machine orchestrator that monitors, tests, screenshots, and auto-fixes 14+ local web apps via Claude Code AI agents. Hub + Agent architecture: hub (Mac Mini) runs all bots; agents (e.g. MacBook Pro) only report status.

## Run
- One service: Express (`node server.js`) serves the dashboard UI (static `public/`) AND the control API on port 9875. No Next.js, no build step.
- Dev (watch mode): `npm run dev` (= `node --watch server.js`); prod: `npm run start`
- launchd `com.bheng.local-apps-next` runs `start.sh` (`exec node server.js`); KeepAlive is the watchdog.
- Screenshot bot: `npm run screenshots`

## Architecture rules
- Apps register via POST /api/apps - auto-assigns port (3000-9875), a Caddy reverse proxy, and a macOS LaunchAgent.
- Machine role set via machine-role.json or the MACHINE_ROLE env var (hub or agent).
- SQLite (better-sqlite3) stores apps, machines, and remote_apps tables.

## Never do (three independent restart mechanisms - check all three)
- launchd `KeepAlive=true` in `~/Library/LaunchAgents/com.local-apps.<app>.plist` respawns a killed process instantly. A plain kill is useless - must `launchctl bootout` + `launchctl disable` to truly stop it.
- Dashboard auto-restart in server.js `checkAll()` kickstarts any "down" app every 30-60s, gated by `data/auto-restart.json`.
- resource-audit dupe-killer (`~/.claude/skills/resource-audit/audit.py`) kills "duplicate" dev servers every 15 min via a launchd cron.
- These three can fight each other - if an app the user turned off keeps respawning, check KeepAlive first, then auto-restart.json, then resource-audit.

## Key API endpoints
- GET/POST /api/apps, PUT/DELETE /api/apps/:id, GET /api/status, POST /api/start/:id
- GET /api/machines, GET /api/machines/:id/status, GET /api/machines/:id/apps
- GET/POST/DELETE /api/screenshots(/:id)
- GET /api/events (SSE), GET /api/log/:id

## Screenshots and tests
- Screenshots: `public/screenshots/{app}/desktop|mobile(-framed)/` + index.json manifest; view them in the app's Status modal -> Screenshots tab
- Tests: `npm test` (node --test tests/unit/ tests/e2e/), or `npm run test:unit` / `npm run test:e2e`
- Nightly test suite (1am, hub only): `scripts/nightly-tests.sh` runs npm test across 11 repos, auto-fixes failures
