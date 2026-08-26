#!/usr/bin/env node
// consistency.js - the single source of truth for "is an app fully wired?"
// Shared by /onboard (its final gate) AND local-apps (/api/consistency police panel),
// so both enforce the exact same artifact matrix - one rule set, two callers.
//
// Usage:
//   node scripts/consistency.js            # audit every app in the DB
//   node scripts/consistency.js <id>       # audit one app (exit 1 if any gap)
//   node scripts/consistency.js --json     # machine-readable (for /api/consistency)
//   node scripts/consistency.js --icons    # only the icon-family rules (favicon/stickies/tab)
//
// Read-only: it reports gaps, it never writes. Auto-heal lives elsewhere.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const H = os.homedir();
const P = {
  db:      path.join(H, "Sites/local-apps/local.db"),
  favDir:  path.join(H, "Sites/local-apps/public/favicons"),
  saiDir:  path.join(H, "Sites/stickies/public/app-icons"),
  reg:     path.join(H, "Sites/stickies/lib/app-icons.ts"),
  colors:  path.join(H, ".claude/tab-colors.json"),
  tabsh:   path.join(H, ".claude-tabs.sh"),
  caddy:   "/opt/homebrew/etc/Caddyfile",
  laDir:   path.join(H, "Library/LaunchAgents"),
};

const ICON_RULES = new Set(["favicon", "stickies-icon", "stickies-reg", "tab-color", "tab-alias"]);

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const exists = (f) => fs.existsSync(f);

function apps(oneId) {
  if (oneId) return [oneId];
  try {
    const out = execFileSync("sqlite3", [P.db, "SELECT id FROM apps ORDER BY id;"], { encoding: "utf8" });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

function dbRow(id) {
  try {
    const q = `SELECT COALESCE(about,'') about, COALESCE(features,'') features, ` +
              `COALESCE(repo,'') repo, COALESCE(prod_url,'') prod, ` +
              `COALESCE(local_path,'') local_path ` +
              `FROM apps WHERE id='${id.replace(/'/g, "''")}';`;
    const out = execFileSync("sqlite3", ["-json", P.db, q], { encoding: "utf8" }).trim();
    return (out ? JSON.parse(out) : [])[0] || {};
  } catch { return {}; }
}

// The rule set. Each returns true (ok) or false (miss). ORDER = display order.
function checkApp(id) {
  const reg = read(P.reg);
  const colors = read(P.colors);
  const tabsh = read(P.tabsh);
  const caddy = read(P.caddy);
  const row = dbRow(id);
  const canonAlias = "_" + id.replace(/-/g, "_");
  const aliasNames = tabsh.split("\n")
    .filter((l) => new RegExp(`_tab\\s+"${id}"`).test(l))
    .map((l) => (l.match(/^\s*(_[a-z0-9_]+)\(\)/) || [])[1]).filter(Boolean);
  const hasCanon = aliasNames.includes(canonAlias);
  const shortcuts = aliasNames.filter((n) => n !== canonAlias);

  // Vercel app? a deployed app has a .vercel/project.json in its repo. Only Vercel
  // apps must carry a prod_url in the modal (owner rule 2026-08-05); local-only exempt.
  const lp = row.local_path || path.join(H, "Sites", id);
  const isVercel = exists(path.join(lp, ".vercel", "project.json"));

  const checks = [
    ["favicon",       exists(path.join(P.favDir, `${id}.png`))],
    ["stickies-icon", exists(path.join(P.saiDir, `${id}.png`))],
    ["stickies-reg",  new RegExp(`"${id}"\\s*:`).test(reg)],
    ["tab-color",     new RegExp(`"${id}"\\s*:`).test(colors)],
    ["tab-alias",     hasCanon && shortcuts.length === 0],
    ["caddy-host",    new RegExp(`${id}\\.localhost`).test(caddy)],
    ["launch-agent",  exists(path.join(P.laDir, `com.bheng.${id}.plist`))],
    ["profile",       !!(row.about && row.features && row.features !== "[]")],
    ["repo",          !!row.repo],
    ["prod-url",      !isVercel || !!row.prod],
  ];
  const note = shortcuts.length ? `shortcut alias ${shortcuts.join(",")} - want only ${canonAlias}`
             : (!hasCanon ? `missing alias ${canonAlias}` : "");
  return { checks, note };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const iconsOnly = argv.includes("--icons");
  const id = argv.find((a) => !a.startsWith("--"));
  const list = apps(id);
  if (!list.length) { console.error("no apps found (is local.db present?)"); process.exit(2); }

  const report = list.map((app) => {
    const { checks, note } = checkApp(app);
    const relevant = iconsOnly ? checks.filter(([k]) => ICON_RULES.has(k)) : checks;
    const misses = relevant.filter(([, ok]) => !ok).map(([k]) => k);
    return { id: app, ok: misses.length === 0, misses, note: misses.includes("tab-alias") ? note : "" };
  });

  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  const dirty = report.filter((r) => !r.ok);
  const scope = iconsOnly ? " (icon rules only)" : "";
  console.log(`CONSISTENCY POLICE${scope} - ${list.length} app(s): ${list.length - dirty.length} clean, ${dirty.length} with gaps\n`);
  for (const r of dirty) {
    console.log(`  x ${r.id}`);
    console.log(`      missing: ${r.misses.join(", ")}${r.note ? `  [${r.note}]` : ""}`);
  }
  if (!dirty.length) console.log("  all apps fully wired - tidy.");
  process.exit(id && dirty.length ? 1 : 0);
}

main();
