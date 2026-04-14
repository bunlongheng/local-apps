#!/usr/bin/env python3
"""
sync-env: Scan all .env files in ~/Sites and push to Safe API.
Usage: python3 scripts/sync-env.sh [--machine m2] [--host http://localhost:6100]
"""

import os, json, subprocess, socket, argparse

SITES_DIR = os.path.expanduser("~/Sites")
SKIP_SUFFIXES = (".example", ".sample", ".template")
DEFAULT_HOST = "http://localhost:6100"
SAFE_API_KEY = os.environ.get("SAFE_API_KEY", "")

def collect_keys(sites_dir):
    keys = []
    for root, dirs, files in os.walk(sites_dir):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", ".next", "target")]
        for f in files:
            if not f.startswith(".env") or any(f.endswith(s) for s in SKIP_SUFFIXES):
                continue
            filepath = os.path.join(root, f)
            rel = os.path.relpath(filepath, sites_dir)
            parts = rel.split(os.sep)
            source = parts[0] + "/" + parts[-1] if len(parts) > 1 else parts[0]
            try:
                with open(filepath, "r", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, _, v = line.partition("=")
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k:
                            keys.append({
                                "key_name": k,
                                "key_value": v,
                                "source": source,
                                "status": "active",
                                "purpose": "",
                                "owner": ""
                            })
            except Exception as e:
                print(f"SKIP {filepath}: {e}")
    return keys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--machine", default=socket.gethostname().split(".")[0])
    parser.add_argument("--host", default=DEFAULT_HOST)
    args = parser.parse_args()

    keys = collect_keys(SITES_DIR)
    payload = json.dumps({"machine": args.machine, "machine_name": args.machine, "keys": keys})

    tmp = "/tmp/env_payload.json"
    with open(tmp, "w") as f:
        f.write(payload)

    headers = ["-H", "Content-Type: application/json"]
    if SAFE_API_KEY:
        headers += ["-H", f"Authorization: Bearer {SAFE_API_KEY}"]

    result = subprocess.run([
        "curl", "-s", "-w", "\nHTTP_STATUS:%{http_code}",
        "-X", "POST", *headers,
        "-d", f"@{tmp}",
        f"{args.host}/api/keys/push"
    ], capture_output=True, text=True, timeout=30)

    print(f"Machine: {args.machine} | Keys: {len(keys)}")
    print(result.stdout)
    if result.stderr:
        print("STDERR:", result.stderr)

if __name__ == "__main__":
    main()
