# <img src="docs/icon.png" width="36" height="36" align="top" alt=""> Local Apps

Self-healing dashboard for a fleet of local dev apps.

Register an app once. Local Apps assigns it a port, writes its Caddy reverse proxy and macOS LaunchAgent, health-checks it every 30 seconds, restarts it when it crashes, and exposes it by name over LAN and Tailscale. One page instead of a wall of `npm run dev` tabs. It runs 65 apps on a base M4 Mac Mini, about 6 awake at a time, the rest parked at zero cost.

![Local Apps dashboard](docs/screenshots/dashboard.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/runtime%20deps-2-000000)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003b57?logo=sqlite)

## Features

- **One page** - live status over SSE, with LAN, Tailscale, and production links, plus a QR code for your phone.
- **Zero-config onboarding** - `POST /api/apps` with an id; port, `<id>.localhost` proxy, and LaunchAgent are provisioned for you.
- **Self-healing** - a down app walks 5 levels: kickstart, port-kill and reload, log-driven fixes, an optional local AI agent, and a circuit breaker that parks a flapping app instead of looping.
- **Multi-machine** - a hub runs the bots; agent machines only report status.
- **Fails closed off-box** - loopback is trusted; any other caller is denied mutations and log reads unless it sends `x-local-apps-token`.

## Quick start

Node 22 or newer (`.nvmrc` is set; `nvm use` picks it up).

```bash
git clone https://github.com/bunlongheng/local-apps.git
cd local-apps
npm install
npm run dev
```

Open http://localhost:9875. With no `apps.config.json` it seeds 2 demo apps. Register your own:

```bash
curl -X POST http://localhost:9875/api/apps \
  -H "Content-Type: application/json" \
  -d '{"id":"hello-app","localPath":"/path/to/hello-app"}'
```

Caddy proxies and LaunchAgents are macOS features (Homebrew Caddy). Elsewhere the dashboard and API run in monitoring mode.

## How it works

One Node 22 process on `node:http`, no framework, no build step. `server.js` serves the vanilla-JS dashboard in `public/` and owns the API, backed by SQLite. When an app goes down:

| Level | After | Action |
|-------|-------|--------|
| L1 | detect | `launchctl` kickstart |
| L2 | 90s | kill the port, full reload |
| L3 | 180s | read the log, `npm install`, clear stale build cache, restart |
| L4 | 300s | optional: hand it to a local Claude Code CLI agent |
| L5 | 3 flaps in 2 min | circuit breaker: park it OFF, re-arm when healthy |

## Hub extras

On the `hub` role only, 5 routes serve the owner's own workflow rather than the product: `/api/tab-colors`, `/api/consistency`, `/api/app-profiles`, `/api/icon-sync`, `/api/capabilities`. They read optional local files and repos; on an `agent` machine they are not registered.

## Configuration

No environment variables are required.

| Env var | Default | Purpose |
|---------|---------|---------|
| `MACHINE_ROLE` | `hub` | `hub` runs bots and auto-fix; `agent` reports only |
| `CADDYFILE` | `/opt/homebrew/etc/Caddyfile` | Caddyfile the monitor edits |
| `API_BIND` | `0.0.0.0` | `127.0.0.1` keeps the API off the LAN |
| `LOCAL_APPS_TOKEN` | unset | grants a trusted LAN or tailnet machine control |
| `LOCAL_APPS_DB` | `./local.db` | SQLite file; tests point it at a temp file |
| `LOCAL_APPS_DEBUG` | unset | `1` logs the failures the restart chain tolerates |

Optional integration: if `~/.claude/tab-colors.json` exists, the dashboard reads tab colors from it and renaming an app writes the label back. No file, no effect.

## Layout and tests

```
server.js   API, SSE, provisioning, health and restart loop
db.js       SQLite data layer
public/     vanilla-JS dashboard
lib/        tested modules: http-app, validate, auth-gate, caddy, launchd, health, breaker
tests/      npm run test:unit, npm test (e2e needs the app on :9875), npm run lint
```

## License

[MIT](LICENSE) (c) Bunlong Heng
