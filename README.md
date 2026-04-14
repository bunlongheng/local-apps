# Local Apps

A self-healing app monitor for local development. Tracks all your apps, auto-restarts crashed ones, runs nightly tests, takes screenshots, and deploys AI agents to fix failures automatically.

## Features

- **Dashboard** - See all apps at a glance with live status, hostnames, LAN, Tailscale, and Vercel links
- **Auto-restart** - Detects crashed apps every 30s and restarts via launchctl
- **Health check + AI fix** - Every 5 min, quick fixes first, then Claude Code agents for stubborn failures
- **Nightly tests** - Runs unit + e2e tests across all repos, agents auto-fix failures
- **Link crawler** - Visits every page, screenshots errors, agents fix broken pages
- **Screenshot bot** - Playwright captures desktop + mobile with MacBook Air / iPhone device frames
- **GIF recorder** - 30s HD animated recordings, compressed to 5s loops
- **Deep audit** - Catches cache corruption, native module mismatches, port conflicts
- **Security scan** - AI agents flag vulnerabilities (report only, no auto-fix)
- **Multi-machine** - Hub/agent architecture, sync apps across machines via LAN
- **Tailscale + Cloudflare** - Access all apps remotely from anywhere
- **Auto port assignment** - Register an app, get a port automatically, conflicts rejected
- **Zero config** - Just `npm start` and add apps via API

## Quick Start

```bash
# Clone and install
git clone https://github.com/bunlongheng/local-apps.git
cd local-apps
npm install

# Start
npm start
```

Open http://localhost:9876

## Add an App

```bash
curl -X POST http://localhost:9876/api/apps \
  -H "Content-Type: application/json" \
  -d '{"id":"my-app","name":"My App","localPath":"/path/to/my-app"}'
```

That's it. The monitor automatically:
- Assigns the next available port
- Creates a Caddy reverse proxy at `http://my-app.localhost`
- Creates a macOS LaunchAgent for process management
- Begins health-checking every 30s
- Auto-restarts if it crashes

No port needed. No config files. No setup.

## Optional Setup

### Caddy (*.localhost hostnames)

```bash
brew install caddy
```

### Screenshots + GIFs

Playwright is included. Just run:

```bash
node scripts/screenshot-bot.js           # all apps
node scripts/screenshot-bot.js my-app    # single app
node scripts/gif-bot.js my-app           # animated GIF
```

### AI Auto-Fix Agents

Install [Claude Code](https://claude.ai/code) and the health check will deploy agents to fix crashed apps and failing tests automatically.

### Tailscale (remote access)

Install [Tailscale](https://tailscale.com) and the dashboard shows Tailscale links for every app. Access from your phone, tablet, or any machine on your tailnet.

### Machine Roles

For multi-machine setups, create `machine-role.json`:

```json
{"role": "hub"}
```

- **hub** - Runs all bots, auto-fix agents, nightly jobs
- **agent** - Status reporting only, no bots (for your dev machine)

## 24-Hour Automation

| Time | Job | Auto-Fix |
|------|-----|----------|
| Every 30s | Auto-restart down apps | Yes |
| Every 5 min | Health check + AI agents | Yes |
| 12:00 AM | Git pull all repos | - |
| 1:00 AM | Nightly tests (unit + e2e) | Yes |
| 1:30 AM | Link crawler | Yes |
| 2:00 AM | Screenshot bot | - |
| 3:00 AM | GIF recordings | - |
| 4:00 AM | Deep infrastructure audit | Yes |
| 5:00 AM | Security + performance scan | Flags only |
| 6:00 AM | Summary report | - |

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | All apps with health status |
| GET | `/api/apps` | List all apps |
| POST | `/api/apps` | Register app (auto-assigns port) |
| PUT | `/api/apps/:id` | Update app |
| DELETE | `/api/apps/:id` | Remove app |
| POST | `/api/start/:id` | Start an app |
| GET | `/api/machines` | Discovered peer machines |
| GET | `/api/all-apps` | Local + remote apps |
| GET | `/api/crons` | Cron job status and logs |
| GET | `/api/screenshots/:id` | App screenshots |
| POST | `/api/screenshots/:id` | Trigger screenshot bot |

## Requirements

- **Node.js** 20+
- **macOS** (uses launchctl for process management)

Everything else is optional.

## License

MIT

## Author

[Bunlong Heng](https://bheng.vercel.app)
