# Local Apps

A self-healing dashboard for a fleet of local dev apps. Register an app and it auto-assigns a port, wires a Caddy reverse proxy and a macOS LaunchAgent, then health-checks it, restarts it when it crashes, screenshots it, and exposes it over LAN and Tailscale - all from one page.

![Local Apps dashboard](docs/screenshots/dashboard.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-149eca?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003b57?logo=sqlite)
![Tests](https://img.shields.io/badge/tests-node%3Atest-6da55f?logo=node.js)

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [How a health check works](#how-a-health-check-works)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Testing](#testing)
- [License](#license)

## Features

- **One-page dashboard** - live status for every app over SSE, with LAN, Tailscale, and Vercel links and a scannable QR for phone access.
- **Zero-config onboarding** - `POST /api/apps` with an id and it auto-assigns a free port, writes a Caddy reverse proxy at `<id>.localhost`, and creates a macOS LaunchAgent.
- **Self-healing** - a 30s async health loop marks apps up/down; a down app is restarted via `launchctl`, with a bootstrap fallback and cache-corruption recovery.
- **AI auto-fix (optional)** - when a restart does not stick, it can hand the failure to a Claude Code agent to diagnose and fix.
- **Screenshots + gallery** - Playwright captures desktop and mobile framed shots into a browsable gallery.
- **Multi-machine** - a hub runs the bots; agent machines report status only. Sync app lists across machines on the LAN.
- **Loops and routines** - view and manage interval- and calendar-scheduled `launchd` automations from the UI.
- **API + Swagger** - a documented REST + SSE control API.

## Architecture

Two processes: a Next.js dashboard for the UI and an Express control API that owns all OS orchestration, backed by SQLite. The dashboard is the only thing on the network - it proxies to the control API, which binds to localhost.

```mermaid
flowchart LR
    Browser["Browser / phone (LAN, Tailscale)"] -->|http| Dash["Next.js dashboard :9876"]
    Dash -->|/api/* proxy| API["Express control API :9875 (127.0.0.1)"]
    API --> DB[("SQLite (better-sqlite3)")]
    API --> Caddy["Caddyfile - reverse proxy"]
    API --> Launchd["macOS LaunchAgents"]
    API --> Health["health loop -> restart / AI fix"]
```

| Layer | Role |
|-------|------|
| `app/` (Next.js) | Dashboard, gallery, docs, loops, routines - a thin client over the API |
| `server.js` (Express) | Control plane: REST + SSE, provisioning, health loop |
| `db.js` (SQLite) | Data layer - apps, machines, profiles; fully parameterized |
| `lib/` | Focused, tested modules: `validate`, `caddy`, `launchd`, `health` |
| `scripts/` | Screenshots, crawlers, icon generation, ops automations |

## How a health check works

```mermaid
sequenceDiagram
    participant Loop as Health loop (30s)
    participant H as lib/health
    participant App as Target app
    participant LD as launchctl
    Loop->>H: checkAll()
    H->>App: tcpCheck(healthUrl) or processCheck
    App-->>H: up / down
    alt was up, now down
        H->>LD: restart via LaunchAgent
        LD-->>H: started (bootstrap fallback if needed)
    end
    H-->>Loop: broadcast status over SSE
```

## Tech stack

- **Next.js 16** + **React 19** + **TypeScript** (strict) - dashboard UI
- **Express 4** - the control-plane API (`server.js`)
- **better-sqlite3** - embedded, synchronous SQLite via `db.js`
- **Playwright** + **Sharp** - screenshots and image processing
- **Caddy** - per-app `*.localhost` reverse proxies (host tool)
- **Tailscale** - optional remote access (host tool)
- **node:test** + **ESLint** - unit/e2e tests and backend lint

## Quick start

```bash
git clone https://github.com/bunlongheng/local-apps.git
cd local-apps
npm install

# start the dashboard (:9876) and the control API (:9875)
npm run dev      # Next.js dashboard
npm run server   # Express control API (separate terminal)
```

Open http://localhost:9876. On first run with no `apps.config.json`, it seeds a demo from `apps.config.example.json`.

Register an app:

```bash
curl -X POST http://localhost:9876/api/apps \
  -H "Content-Type: application/json" \
  -d '{"id":"my-app","localPath":"/Users/me/Sites/my-app"}'
```

> Caddy reverse proxies and macOS LaunchAgents are host-only features (macOS + Homebrew Caddy). A `Dockerfile` is included to run the dashboard + API in monitoring ("agent") mode elsewhere.

## Configuration

No environment variables are required. All are optional:

| Env var | Default | Purpose |
|---------|---------|---------|
| `MACHINE_ROLE` | `hub` | `hub` runs bots + auto-fix + nightly jobs; `agent` reports status only |
| `CADDYFILE` | `/opt/homebrew/etc/Caddyfile` | Caddyfile the monitor edits when provisioning proxies |
| `API_BIND` | `127.0.0.1` | Interface the control API binds to (keep localhost unless you run trusted peer sync) |
| `PORTFOLIO_ENV_PATH` | unset | Optional path to a `.env.local` for the portfolio integration |

See `.env.example`. Role can also be set in `machine-role.json`.

## Project layout

```
app/            Next.js dashboard (status, gallery, docs, loops, routines)
components/     Shared React components
server.js       Express control API: REST + SSE, provisioning, health loop
db.js           SQLite data layer (better-sqlite3)
lib/
  validate.js   Input validation + escaping
  caddy.js      Caddyfile reverse-proxy management
  launchd.js    macOS LaunchAgent create/remove
  health.js     Health-check primitives (state, tcp/process check)
launchctl-cmds.js, launchd-parse.js   launchctl helpers
scripts/        Screenshots, crawlers, icon generation, ops automations
tests/          unit/ (helpers) + e2e/ (route guards)
public/         Static assets, gallery
Dockerfile      Dashboard + API in agent mode
```

## Testing

```bash
npm test          # unit + e2e (e2e needs a running instance on :9876)
npm run test:unit # unit only
npm run lint      # ESLint on the Node backend
```

## License

[MIT](LICENSE) (c) Bunlong Heng
