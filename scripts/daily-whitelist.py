#!/usr/bin/env python3
"""Daily 8AM enforcement: keep ONLY the 5 whitelisted local apps running; turn everything
else off - and keep it off across all three restart mechanisms:

  1. dashboard auto-restart  -> POST /api/apps/bulk-toggle sets db.disabled on the rest
  2. launchd KeepAlive       -> launchctl bootout + disable each non-whitelisted agent
  3. stray port holders      -> kill whatever still listens on a disabled app's port

The 5 whitelisted agents are launchctl-enabled and (re)started if down. Idempotent; safe to
re-run. Logs each run to ~/.claude/logs/daily-whitelist.log.
"""
import json, os, subprocess, urllib.request, datetime

KEEP = {"bheng", "claude", "stickies", "local-apps", "jobs"}
API = "http://local-apps.localhost"
UID = str(os.getuid())
LOG = os.path.expanduser("~/.claude/logs/daily-whitelist.log")


def sh(cmd):
    try:
        subprocess.run(cmd, shell=True, capture_output=True, timeout=20)
    except Exception:
        pass


def api_get(path):
    try:
        return json.load(urllib.request.urlopen(API + path, timeout=10))
    except Exception:
        return None


def api_post(path, payload):
    try:
        req = urllib.request.Request(API + path, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        return json.load(urllib.request.urlopen(req, timeout=25))
    except Exception:
        return None


def port_of(a):
    url = a.get("localUrl") or ""
    if ":" in url:
        p = url.rsplit(":", 1)[-1].split("/")[0]
        return p if p.isdigit() else ""
    return ""


apps = api_get("/api/apps") or []
if isinstance(apps, dict):
    apps = apps.get("apps", [])

# 1) launchd + port level: enable the 5's agents; bootout+disable+free-port for everything else
for a in apps:
    aid, lbl = a.get("id"), a.get("launchAgent")
    if aid in KEEP:
        if lbl:
            sh(f"launchctl enable gui/{UID}/{lbl}")
    else:
        if lbl:
            sh(f"launchctl bootout gui/{UID}/{lbl} 2>/dev/null; launchctl disable gui/{UID}/{lbl} 2>/dev/null")
        p = port_of(a)
        if p:
            sh(f"lsof -ti :{p} 2>/dev/null | xargs kill -9 2>/dev/null")

# 2) db level: keep only the 5 enabled (stops dashboard auto-restart of the rest; starts the 5)
api_post("/api/apps/bulk-toggle", {"keep": list(KEEP)})

# 3) make sure every whitelisted app is actually up
st = api_get("/api/status") or {}
up = {a.get("id") for a in st.get("apps", []) if a.get("status") == "up"}
for k in KEEP:
    if k not in up:
        api_post(f"/api/start/{k}", {})

# 4) log the outcome
st2 = api_get("/api/status") or {}
run = sorted(a.get("id") for a in st2.get("apps", []) if a.get("status") == "up")
os.makedirs(os.path.dirname(LOG), exist_ok=True)
with open(LOG, "a") as f:
    f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} enforced whitelist -> running {len(run)}: {run}\n")
print("running:", run)
