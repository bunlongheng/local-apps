# Apps Monitor

A lightweight local process supervisor and health dashboard for macOS. Monitors your apps via TCP port checks or process name, with real-time SSE updates, browser notifications, and a click-through modal for each app.

## Features

- Real-time status dashboard (up / down / unknown)
- TCP port checks (IPv4 + IPv6 fallback)
- Process name checks via `pgrep` for non-HTTP apps (Electron, scripts)
- Server-Sent Events for live updates — no polling
- Click any row to see full app details (repo, paths, URLs, LaunchAgent)
- PWA-ready with icons and manifest
- Browser notifications when an app goes down
- Auto-reloads dashboard when config or UI files change

## Setup

```bash
cp apps.config.example.json apps.config.json
# Edit apps.config.json with your apps
npm install
node server.js
```

Open [http://localhost:9876](http://localhost:9876)

## Config

Each entry in `apps.config.json`:

| Field | Description |
|---|---|
| `id` | Unique identifier |
| `name` | Display name |
| `healthUrl` | URL for TCP port check (e.g. `http://localhost:3000`) |
| `localUrl` | Clickable localhost link shown in dashboard |
| `processCheck` | Process name to check via `pgrep -f` (for non-HTTP apps) |
| `repo` | GitHub repo URL |
| `localPath` | Filesystem path to the project |
| `logPath` | Path to log file |
| `launchAgent` | macOS LaunchAgent label |
| `launchAgentPath` | Path to the `.plist` file |

## Running as a LaunchAgent

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/Users/username/apps-monitor/server.js</string>
</array>
```

See `apps.config.example.json` for a full example.
