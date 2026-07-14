"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface Loop {
  session: string;
  project: string;
  tool: string;
  prompt: string;
  reason: string;
  schedule: string;
  delay: number;
  ageSecs: number;
  source: string;
  kind: "session" | "launchd";
  pid?: number;
  name?: string;
  label?: string;
  enabled?: boolean;
}

interface Machine {
  id: string;
  hostname?: string;
  ip: string;
  port?: number;
  model?: string;
}

const DEVICE_MAP: Record<string, string> = {
  "mac mini": "mac-mini",
  "macbook pro": "macbook-pro",
  "macbook air": "macbook-air",
};

function deviceIcon(model: string | null | undefined): string | null {
  if (!model) return null;
  const key = Object.keys(DEVICE_MAP).find((k) => model.toLowerCase().includes(k));
  return key ? `/devices/${DEVICE_MAP[key]}.png` : null;
}

const LAUNCHD_ICON: Record<string, string> = {
  "com.local-apps.sync-claude": "claude",
};

// Inline SVG icons (take precedence over favicon images) for automations
// that have no fitting favicon asset.
const LAUNCHD_SVG: Record<string, React.ReactNode> = {
  "com.local-apps.resource-audit": (
    <span
      style={{
        width: 24, height: 24, flexShrink: 0, marginTop: 1, borderRadius: 6,
        background: "rgba(248,113,113,0.12)", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    </span>
  ),
};

/* Toggle switch (same as monitoring page app-detail toggle) */
function ToggleSwitch({
  checked, onChange, title, disabled,
}: { checked: boolean; onChange: (v: boolean) => void; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      title={title}
      style={{
        position: "relative", width: 36, height: 20, borderRadius: 10, border: "none",
        cursor: disabled ? "not-allowed" : "pointer", transition: "background 0.2s", flexShrink: 0,
        opacity: disabled ? 0.45 : 1,
        background: checked ? "#22c55e" : "rgba(255,255,255,0.1)",
      }}
    >
      <span
        style={{
          position: "absolute", top: 2, left: checked ? 18 : 2, width: 16, height: 16,
          borderRadius: "50%", background: "#fff", transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  );
}

function ago(secs: number): string {
  if (secs >= 999999) return "never";
  if (secs < 60) return secs + "s ago";
  const m = Math.floor(secs / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  return h + "h ago";
}

function interval(l: Loop): string {
  if (l.tool === "CronCreate") return l.schedule || "cron";
  if (l.schedule) return l.schedule;
  if (!l.delay) return "self-paced";
  return l.delay >= 60 ? `${Math.round(l.delay / 60)}m` : `${l.delay}s`;
}

interface LogRow {
  time: string;
  rest: string;
  dot: "ok" | "err" | "info";
}

function parseLogLine(line: string): LogRow {
  const m = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+(.*)$/);
  if (!m) return { time: "", rest: line, dot: "info" };
  const [, ymd, hms, rest] = m;
  const d = new Date(`${ymd}T${hms}`);
  const time = isNaN(d.getTime())
    ? `${ymd} ${hms}`
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const low = rest.toLowerCase();
  const dot: LogRow["dot"] = /error|fail|warn|✗|denied|abort/.test(low) ? "err" : /\bok\b|synced|done|success|posted|sticky-ok|up to date|committed|pushed|pulled/.test(low) ? "ok" : "info";
  return { time, rest, dot };
}

const DOT_COLOR: Record<LogRow["dot"], string> = { ok: "#4ade80", err: "#f87171", info: "#666" };

const INTERVAL_OPTIONS: { label: string; secs: number }[] = [
  { label: "5m", secs: 300 },
  { label: "10m", secs: 600 },
  { label: "15m", secs: 900 },
  { label: "30m", secs: 1800 },
  { label: "1h", secs: 3600 },
  { label: "2h", secs: 7200 },
  { label: "6h", secs: 21600 },
  { label: "12h", secs: 43200 },
  { label: "24h", secs: 86400 },
];

function loopKey(l: Loop): string {
  return l.kind === "launchd" ? `launchd:${l.label}` : `session:${l.session}`;
}

export default function LoopsPage() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [brokenIcons, setBrokenIcons] = useState<Record<string, boolean>>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [machines, setMachines] = useState<Machine[]>([]);
  const [activeMachine, setActiveMachine] = useState<string | null>(null);
  const [localInfo, setLocalInfo] = useState<{ hostname?: string; model?: string }>({});
  const activeRef = useRef<string | null>(null);
  useEffect(() => { activeRef.current = activeMachine; }, [activeMachine]);

  const isRemote = activeMachine !== null;

  const load = useCallback(async () => {
    const m = activeRef.current;
    try {
      const url = m ? `/api/machines/${encodeURIComponent(m)}/loops` : "/api/loops";
      const res = await fetch(url);
      if (!res.ok) throw new Error("unreachable");
      const data = await res.json();
      setLoops(Array.isArray(data.loops) ? data.loops : []);
      setError(false);
    } catch {
      setLoops([]);
      setError(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetch("/api/machine").then((r) => r.json()).then((d) => setLocalInfo({ hostname: d.hostname, model: d.model })).catch(() => {});
    fetch("/api/machines").then((r) => r.json()).then((d) => setMachines(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  useEffect(() => {
    setLoaded(false);
    setOpenLog(null);
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load, activeMachine]);

  const toggleLog = useCallback(async (l: Loop) => {
    const key = loopKey(l);
    if (openLog === key) { setOpenLog(null); return; }
    setOpenLog(key);
    setLogLoading(true);
    setLogLines([]);
    try {
      const q =
        l.kind === "launchd"
          ? `kind=launchd&label=${encodeURIComponent(l.label || "")}`
          : `kind=session&session=${encodeURIComponent(l.session)}`;
      const base = activeRef.current ? `/api/machines/${encodeURIComponent(activeRef.current)}/loops/log` : "/api/loops/log";
      const res = await fetch(`${base}?${q}`);
      const data = await res.json();
      setLogLines(Array.isArray(data.lines) ? data.lines : []);
    } catch {
      setLogLines(["(failed to load log)"]);
    } finally {
      setLogLoading(false);
    }
  }, [openLog]);

  const onToggle = useCallback(async (l: Loop, value: boolean) => {
    if (l.kind === "session") {
      if (value) return;
      if (!confirm(`Kill the entire "${l.project}" session (pid ${l.pid})?\n\nThis stops the loop AND the whole Claude session - any unsaved work in it is lost.`)) return;
    }
    const key = loopKey(l);
    // optimistic flip for launchd so the switch responds immediately
    if (l.kind === "launchd") {
      setLoops((prev) => prev.map((x) => (loopKey(x) === key ? { ...x, enabled: value } : x)));
    }
    setBusy(key);
    try {
      const body =
        l.kind === "session"
          ? { kind: "session", pid: l.pid }
          : { kind: "launchd", label: l.label, action: value ? "start" : "stop" };
      const killUrl = activeRef.current ? `/api/machines/${encodeURIComponent(activeRef.current)}/loops/kill` : "/api/loops/kill";
      const res = await fetch(killUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        alert("Failed: " + (data.error || res.status));
        if (l.kind === "launchd") setLoops((prev) => prev.map((x) => (loopKey(x) === key ? { ...x, enabled: !value } : x)));
      }
    } catch (e) {
      alert("Failed: " + e);
      if (l.kind === "launchd") setLoops((prev) => prev.map((x) => (loopKey(x) === key ? { ...x, enabled: !value } : x)));
    } finally {
      setBusy(null);
      setTimeout(load, 400);
    }
  }, [load]);

  const onSetInterval = useCallback(async (l: Loop, secs: number) => {
    if (l.kind !== "launchd" || secs === l.delay) return;
    const key = loopKey(l);
    const prev = l.delay;
    setLoops((p) => p.map((x) => (loopKey(x) === key ? { ...x, delay: secs } : x)));
    setBusy(key);
    try {
      const url = activeRef.current ? `/api/machines/${encodeURIComponent(activeRef.current)}/loops/interval` : "/api/loops/interval";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: l.label, seconds: secs }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert("Failed: " + (data.error || res.status));
        setLoops((p) => p.map((x) => (loopKey(x) === key ? { ...x, delay: prev } : x)));
      }
    } catch (e) {
      alert("Failed: " + e);
      setLoops((p) => p.map((x) => (loopKey(x) === key ? { ...x, delay: prev } : x)));
    } finally {
      setBusy(null);
      setTimeout(load, 400);
    }
  }, [load]);

  const localName = (localInfo.hostname || "").replace(".local", "") || "This Mac";

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "28px 0 6px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: 0 }}>Loops</h1>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            fontFamily: "'SF Mono', monospace",
            padding: "3px 10px",
            borderRadius: 20,
            background: loops.length ? "rgba(74,222,128,0.15)" : "rgba(255,255,255,0.05)",
            color: loops.length ? "#4ade80" : "var(--muted)",
          }}
        >
          {loops.length} running
        </span>
      </div>
      <p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 14px" }}>
        Live <code>/loop</code> sessions and recurring automations per machine. The switch stops a
        session (kills its whole process) or toggles an automation&apos;s launchd agent. Tap
        <strong> Log</strong> for run history. Auto-refreshes every 15s.
      </p>

      {/* Machine tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 0 16px", flexWrap: "wrap" }}>
        <button onClick={() => setActiveMachine(null)} className={`machine-tab${!activeMachine ? " active" : ""}`}>
          {deviceIcon(localInfo.model) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={deviceIcon(localInfo.model)!} width={14} height={14} alt="" style={{ opacity: 0.7 }} />
          )}
          {localName}
        </button>
        {machines.map((m) => {
          const mIcon = deviceIcon(m.model);
          const mName = (m.hostname || m.ip).replace(".local", "");
          return (
            <button key={m.id} onClick={() => setActiveMachine(m.id)} className={`machine-tab${activeMachine === m.id ? " active" : ""}`}>
              {mIcon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mIcon} width={14} height={14} alt="" style={{ opacity: 0.7 }} />
              )}
              {mName}
            </button>
          );
        })}
      </div>

      {loaded && error && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "32px 20px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          {isRemote ? "Machine unreachable (or its dashboard needs the latest update)." : "Loops API unreachable - retrying..."}
        </div>
      )}

      {loaded && !error && loops.length === 0 && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "32px 20px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          No loops running right now.
        </div>
      )}

      {!error && loops.length > 0 && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {loops.map((l, i) => {
            const key = loopKey(l);
            const isLaunchd = l.kind === "launchd";
            const dotColor = isLaunchd ? "#60a5fa" : "#4ade80";
            const svgIcon = isLaunchd ? LAUNCHD_SVG[l.label || ""] : null;
            const iconId = isLaunchd ? LAUNCHD_ICON[l.label || ""] : l.project;
            const showIcon = !!iconId && !brokenIcons[iconId];
            const switchOn = isLaunchd ? !!l.enabled : true;
            return (
              <div key={key + i} style={{ borderBottom: i < loops.length - 1 ? "1px solid var(--border)" : "none" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px" }}>
                  {svgIcon ? (
                    svgIcon
                  ) : showIcon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/favicons/${iconId}.png`}
                      alt={iconId}
                      width={24}
                      height={24}
                      onError={() => setBrokenIcons((p) => ({ ...p, [iconId!]: true }))}
                      style={{ borderRadius: 6, flexShrink: 0, marginTop: 1, objectFit: "cover" }}
                    />
                  ) : (
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0, marginTop: 5, boxShadow: `0 0 6px ${dotColor}b3` }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{l.project || "(unknown)"}</span>
                      <span
                        style={{
                          fontFamily: "'SF Mono', monospace", fontSize: 10,
                          color: isLaunchd ? "#60a5fa" : "var(--muted)",
                          background: isLaunchd ? "rgba(96,165,250,0.12)" : "rgba(255,255,255,0.05)",
                          padding: "1px 6px", borderRadius: 4,
                        }}
                      >
                        {isLaunchd ? "automation" : `session ${l.session}`}
                      </span>
                      {!isLaunchd && l.pid ? (
                        <span style={{ fontFamily: "'SF Mono', monospace", fontSize: 10, color: "var(--muted)", background: "rgba(255,255,255,0.05)", padding: "1px 6px", borderRadius: 4 }}>
                          pid {l.pid}
                        </span>
                      ) : null}
                      {isLaunchd ? (
                        <select
                          value={l.delay}
                          disabled={busy === key}
                          onChange={(e) => onSetInterval(l, parseInt(e.target.value, 10))}
                          title="Change run interval"
                          style={{
                            fontFamily: "'SF Mono', monospace", fontSize: 10, color: "#f0a020",
                            background: "rgba(240,160,32,0.12)", border: "1px solid rgba(240,160,32,0.25)",
                            padding: "1px 4px", borderRadius: 4, cursor: busy === key ? "wait" : "pointer",
                            appearance: "none", WebkitAppearance: "none",
                          }}
                        >
                          {INTERVAL_OPTIONS.some((o) => o.secs === l.delay) ? null : (
                            <option value={l.delay}>{interval(l)}</option>
                          )}
                          {INTERVAL_OPTIONS.map((o) => (
                            <option key={o.secs} value={o.secs}>{o.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span style={{ fontFamily: "'SF Mono', monospace", fontSize: 10, color: "#f0a020", background: "rgba(240,160,32,0.12)", padding: "1px 6px", borderRadius: 4 }}>
                          {interval(l)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, wordBreak: "break-word", fontFamily: "'SF Mono', monospace" }}>
                      {l.prompt || l.reason || l.tool}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>{ago(l.ageSecs)}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        onClick={() => toggleLog(l)}
                        style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", background: "rgba(255,255,255,0.06)", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 9px", cursor: "pointer" }}
                      >
                        {openLog === key ? "Hide" : "Log"}
                      </button>
                      <ToggleSwitch
                        checked={switchOn}
                        disabled={busy === key}
                        onChange={(v) => onToggle(l, v)}
                        title={
                          isLaunchd
                            ? switchOn ? "Enabled - click to stop" : "Disabled - click to start"
                            : "Running - click to kill the session"
                        }
                      />
                    </div>
                  </div>
                </div>
                {openLog === key && (
                  <div style={{ borderTop: "1px solid var(--border)", background: "rgba(0,0,0,0.25)", padding: "10px 16px", maxHeight: 260, overflowY: "auto" }}>
                    {logLoading ? (
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading...</div>
                    ) : logLines.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>No history recorded.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {[...logLines].reverse().map((line, li) => {
                          const r = parseLogLine(line);
                          return (
                            <div key={li} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11, lineHeight: 1.7, fontFamily: "'SF Mono', monospace" }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: DOT_COLOR[r.dot], flexShrink: 0, alignSelf: "center", boxShadow: r.dot === "ok" ? "0 0 5px rgba(74,222,128,0.6)" : "none" }} />
                              {r.time && <span style={{ color: "var(--text)", whiteSpace: "nowrap", flexShrink: 0 }}>{r.time}</span>}
                              <span style={{ color: "var(--muted)", wordBreak: "break-word" }}>{r.rest}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
