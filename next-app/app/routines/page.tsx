"use client";

import { useState, useEffect, useCallback } from "react";

/* ── Agent icon/color maps (match routines.html exactly) ── */
const AGENT_ICONS: Record<string, number> = {
  "agent-snow": 1, "agent-blaze": 2, "agent-arrow": 3, "agent-venus": 4, "agent-zap": 5,
  "agent-frost": 6, "agent-blitz": 7, "agent-earth": 8, "agent-pulse": 9, "agent-sand": 10,
  "agent-shadow": 11, "agent-rock": 12,
  "nightly-tests": 7, "nightly-crawler": 3, "nightly-screenshots": 6, "nightly-gifs": 12,
  "deep-audit": 8, "nightly-scan": 11, "nightly-summary": 1, "health-check-fix": 1,
  "git-pull-all": 9,
};

const AGENT_COLORS: Record<number, string> = {
  1: "#a5f3fc", 2: "#ef4444", 3: "#ec4899", 4: "#f97316", 5: "#eab308",
  6: "#06b6d4", 7: "#3b82f6", 8: "#22c55e", 9: "#a855f7", 10: "#f97316",
  11: "#6b7280", 12: "#78716c",
};

/* ── Types ── */
interface Cron {
  id: string;
  desc?: string;
  hour?: string;
  enabled?: boolean;
  autoFix?: boolean;
  log?: string;
  lastRun?: string;
  lastLines?: string;
  summaryData?: string | object;
  cost?: [string, number, number, number]; // [label, apps, runs, tokK]
}

/* ── Helpers ── */
function taskName(c: Cron): string {
  if (!c.desc) return c.id.replace(/^agent-/, "").replace(/^nightly-/, "");
  return c.desc.replace(/^.*?\s—\s/, "");
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + "s ago";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

function cronTokDaily(c: Cron): number {
  return c.cost ? c.cost[3] * c.cost[1] * c.cost[2] : 0;
}

function agentIcon(id: string): number | undefined {
  return AGENT_ICONS[id];
}

function agentColor(id: string): string {
  const n = AGENT_ICONS[id];
  return n ? AGENT_COLORS[n] : "#6366f1";
}

/* ── Reusable avatar ── */
function AgentAvatar({ id, size = 32 }: { id: string; size?: number }) {
  const n = agentIcon(id);
  const color = agentColor(id);
  if (n) {
    return (
      <img
        src={`/agents/${n}.png`}
        width={size}
        height={size}
        alt=""
        style={{
          borderRadius: "50%",
          border: `2px solid ${color}`,
          boxShadow: `0 0 8px ${color}40, 0 0 16px ${color}20`,
        }}
      />
    );
  }
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

/* ── Token bar helper ── */
function TokenBar({ pct, label }: { pct: number; label: string }) {
  const color = pct > 75 ? "#ef4444" : pct > 40 ? "#eab308" : "#4ade80";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
        {pct > 0 && <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2 }} />}
      </div>
      <span style={{ fontSize: 9, color: pct > 0 ? color : "var(--muted)", fontWeight: 600, whiteSpace: "nowrap" }}>
        {label}
      </span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Main Page
   ══════════════════════════════════════════════════════════ */
export default function RoutinesPage() {
  const [crons, setCrons] = useState<Cron[]>([]);
  const [tab, setTab] = useState<"config" | "logs" | "tokens">("config");
  const [modalCron, setModalCron] = useState<Cron | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set([0]));

  const loadCrons = useCallback(async () => {
    try {
      const res = await fetch("/api/crons");
      const data = await res.json();
      setCrons(Array.isArray(data) ? data : data.crons || []);
    } catch {
      setCrons([]);
    }
  }, []);

  useEffect(() => { loadCrons(); }, [loadCrons]);

  // Escape key closes modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setModalCron(null); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  /* ── Toggle helpers ── */
  async function toggleEnabled(id: string) {
    try {
      const res = await fetch(`/api/crons/${id}/toggle`, { method: "POST" });
      const data = await res.json();
      setCrons((prev) => prev.map((c) => (c.id === id ? { ...c, enabled: data.enabled } : c)));
    } catch { /* revert handled by optimistic UI below */ }
  }

  async function toggleAll(enable: boolean) {
    try {
      await fetch("/api/crons/toggle-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enable }) });
      await loadCrons();
    } catch { /* ignore */ }
  }

  async function runCron(id: string) {
    setModalCron(null);
    try { await fetch(`/api/crons/${id}/run`, { method: "POST" }); } catch { /* ignore */ }
  }

  async function viewLog(id: string) {
    setModalCron(null);
    try {
      const res = await fetch(`/api/crons/${id}/log?lines=200`);
      const text = await res.text();
      const w = window.open("", "_blank", "width=800,height=600");
      if (w) {
        w.document.write(`<html><head><title>${id} log</title><style>body{background:#0d0d0d;color:#aaa;font:12px/1.6 'SF Mono',monospace;padding:16px;white-space:pre-wrap;word-break:break-all;}</style></head><body>${text.replace(/</g, "&lt;")}</body></html>`);
      }
    } catch { /* ignore */ }
  }

  async function clearLog(id: string) {
    setModalCron(null);
    if (!confirm(`Clear log for ${id}?`)) return;
    try {
      await fetch(`/api/crons/${id}/log`, { method: "DELETE" });
      loadCrons();
    } catch { /* ignore */ }
  }

  /* ── Derived values ── */
  const toggleable = crons.filter((c) => c.id !== "auto-restart");
  const allEnabled = toggleable.length > 0 && toggleable.every((c) => c.enabled !== false);
  const maxTok = Math.max(...crons.map(cronTokDaily), 0);

  /* ── Tab rendering ── */
  const tabs: { key: typeof tab; label: string }[] = [
    { key: "config", label: "Configuration" },
    { key: "logs", label: "Logs" },
    { key: "tokens", label: "Token Budget" },
  ];

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 24px" }}>
      {/* Header */}
      <header style={{ padding: "20px 0", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.5px", color: "#fff" }}>Routines</h1>
            <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>
              {crons.length} scheduled jobs
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ToggleSwitch checked={allEnabled} onChange={toggleAll} title="Toggle all crons" />
            <button
              onClick={loadCrons}
              style={{
                background: "none", border: "1px solid var(--border)", color: "var(--muted)",
                fontFamily: "inherit", fontSize: 11, padding: "5px 14px", borderRadius: 6, cursor: "pointer",
              }}
              onMouseOver={(e) => { e.currentTarget.style.borderColor = "var(--text)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseOut={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--muted)"; }}
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", marginTop: 12 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: "none", border: "none", borderBottom: `2px solid ${tab === t.key ? "#fff" : "transparent"}`,
              color: tab === t.key ? "#fff" : "var(--muted)", fontFamily: "inherit", fontSize: 12,
              fontWeight: 600, padding: "10px 20px", cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Configuration Tab ── */}
      {tab === "config" && (
        <div style={{ padding: "10px 0" }}>
          {crons.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>Loading...</div>
          ) : (
            crons.map((c) => {
              const tok = cronTokDaily(c);
              const pct = maxTok > 0 ? Math.round((tok / maxTok) * 100) : 0;
              const tokLabel = tok > 0 ? (tok / 1000).toFixed(1) + "M" : "0";
              return (
                <div key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <div
                    onClick={() => setModalCron(c)}
                    style={{
                      display: "grid", gridTemplateColumns: "100px 36px 1fr 100px",
                      alignItems: "center", gap: 8, padding: "12px 0", cursor: "pointer", userSelect: "none",
                    }}
                  >
                    {/* Toggle + schedule */}
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ToggleSwitch
                        checked={c.enabled !== false}
                        onChange={() => toggleEnabled(c.id)}
                        title={c.enabled !== false ? "Enabled - click to disable" : "Disabled - click to enable"}
                      />
                      <span style={{ fontSize: 9, color: "var(--muted)", whiteSpace: "nowrap", minWidth: 50 }}>
                        {c.hour || ""}
                      </span>
                    </div>

                    {/* Agent avatar */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <AgentAvatar id={c.id} size={32} />
                    </div>

                    {/* Task name */}
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 400 }}>{taskName(c)}</span>
                    </div>

                    {/* Token bar */}
                    <TokenBar pct={pct} label={tokLabel} />
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── Logs Tab ── */}
      {tab === "logs" && (
        <div style={{ padding: "10px 0" }}>
          {(() => {
            const sorted = [...crons]
              .filter((c) => c.lastRun)
              .sort((a, b) => new Date(b.lastRun!).getTime() - new Date(a.lastRun!).getTime());
            if (!sorted.length) return <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>No logs yet</div>;
            return sorted.map((c, i) => {
              const color = agentColor(c.id);
              const ago = timeAgo(c.lastRun!);
              const ts = new Date(c.lastRun!).toLocaleString();
              const lines = (c.lastLines || "").trim();
              const hasError = lines.toLowerCase().includes("error") || lines.toLowerCase().includes("fail");
              const borderColor = hasError ? "#ef4444" : "#4ade80";
              const isOpen = expandedLogs.has(i);

              return (
                <div
                  key={c.id}
                  style={{
                    marginBottom: 6, border: `1px solid ${borderColor}40`, borderRadius: 8,
                    background: "var(--surface)", overflow: "hidden",
                    boxShadow: `0 0 8px ${borderColor}15`,
                  }}
                >
                  {/* Card header */}
                  <div
                    onClick={() => {
                      setExpandedLogs((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      });
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                      cursor: "pointer", userSelect: "none",
                    }}
                  >
                    <AgentAvatar id={c.id} size={28} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12, color: "var(--text)" }}>{taskName(c)}</span>
                    </div>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", whiteSpace: "nowrap" }}>{ago}</span>
                    <span style={{
                      fontSize: 10, color: "var(--muted)", transition: "transform 0.15s",
                      transform: isOpen ? "rotate(90deg)" : "none",
                    }}>
                      &#9654;
                    </span>
                  </div>

                  {/* Expandable body */}
                  {isOpen && (
                    <div>
                      <div style={{ padding: "0 14px 4px", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{ts}</div>
                      {lines ? (
                        <div style={{
                          margin: "4px 14px 12px", background: "rgba(0,0,0,0.3)",
                          border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6,
                          padding: "10px 12px", fontSize: 10, color: "rgba(255,255,255,0.8)",
                          maxHeight: 200, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
                          lineHeight: 1.6, fontFamily: "'SF Mono','Fira Code',monospace",
                        }}>
                          {lines}
                        </div>
                      ) : (
                        <div style={{ padding: "4px 14px 12px", fontSize: 10, color: "rgba(255,255,255,0.3)", fontStyle: "italic" }}>
                          No output
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}

      {/* ── Token Budget Tab ── */}
      {tab === "tokens" && (
        <div>
          <CostSummary crons={crons} />
          <div style={{ padding: "10px 0" }}>
            {(() => {
              const tokCrons = crons
                .filter((c) => c.cost)
                .map((c) => ({ ...c, tok: cronTokDaily(c) }))
                .sort((a, b) => b.tok - a.tok);
              const maxT = tokCrons.length ? tokCrons[0].tok : 0;

              return tokCrons.map((c) => {
                const pct = maxT > 0 ? Math.round((c.tok / maxT) * 100) : 0;
                const color = pct > 75 ? "#ef4444" : pct > 40 ? "#eab308" : "#4ade80";
                const label = (c.tok / 1000).toFixed(1) + "M";
                const iconNum = AGENT_ICONS[c.id];

                return (
                  <div
                    key={c.id}
                    style={{
                      display: "grid", gridTemplateColumns: "36px 1fr 140px 50px",
                      alignItems: "center", gap: 10, padding: "10px 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <AgentAvatar id={c.id} size={28} />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: iconNum ? AGENT_COLORS[iconNum] : undefined }}>
                        {taskName(c)}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--muted)" }}>
                        {c.cost![3]}K/agent x {c.cost![1]} apps x {c.cost![2]} runs
                      </div>
                    </div>
                    <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} />
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color, textAlign: "right" }}>{label}</div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ── Modal ── */}
      {modalCron && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setModalCron(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300,
            backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <CronModal
            cron={modalCron}
            onClose={() => setModalCron(null)}
            onRun={runCron}
            onViewLog={viewLog}
            onClearLog={clearLog}
          />
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Sub-components
   ══════════════════════════════════════════════════════════ */

/* Toggle switch */
function ToggleSwitch({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label style={{ position: "relative", width: 34, height: 18, flexShrink: 0, cursor: "pointer" }} title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ opacity: 0, width: 0, height: 0, position: "absolute" }}
      />
      <span
        style={{
          position: "absolute", inset: 0, borderRadius: 9, cursor: "pointer", transition: "background 0.2s",
          background: checked ? "rgba(74,222,128,0.25)" : "rgba(255,255,255,0.1)",
        }}
      >
        <span
          style={{
            content: "''", position: "absolute", width: 14, height: 14, left: 2, bottom: 2,
            borderRadius: "50%", transition: "all 0.2s",
            background: checked ? "var(--up)" : "#555",
            transform: checked ? "translateX(16px)" : "translateX(0)",
          }}
        />
      </span>
    </label>
  );
}

/* Cost summary grid */
function CostSummary({ crons }: { crons: Cron[] }) {
  const withCost = crons.filter((c) => c.cost);
  if (!withCost.length) return null;

  let totalDailyTok = 0, claudeJobs = 0, freeJobs = 0;
  for (const c of crons) {
    if (c.cost) {
      totalDailyTok += c.cost[3] * c.cost[1] * c.cost[2];
      claudeJobs++;
    } else {
      freeJobs++;
    }
  }
  const totalMonthlyTok = totalDailyTok * 30;

  return (
    <div style={{
      margin: "16px 0", padding: "14px 16px", background: "var(--surface)",
      border: "1px solid var(--border)", borderRadius: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: "var(--muted)" }}>
          worst-case (all apps fail every run) &middot; Max plan $200/m
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#eab308" }}>{(totalDailyTok / 1000).toFixed(1)}M</div>
          <div style={{ fontSize: 10, color: "var(--muted)" }}>tokens / day</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#eab308" }}>{(totalMonthlyTok / 1000).toFixed(0)}M</div>
          <div style={{ fontSize: 10, color: "var(--muted)" }}>tokens / month</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>
            {claudeJobs}<span style={{ color: "var(--muted)", fontSize: 13 }}> / {claudeJobs + freeJobs}</span>
          </div>
          <div style={{ fontSize: 10, color: "var(--muted)" }}>use Claude</div>
        </div>
      </div>
    </div>
  );
}

/* Cron detail modal */
function CronModal({
  cron: c, onClose, onRun, onViewLog, onClearLog,
}: {
  cron: Cron; onClose: () => void;
  onRun: (id: string) => void; onViewLog: (id: string) => void; onClearLog: (id: string) => void;
}) {
  const color = agentColor(c.id);
  const tok = cronTokDaily(c);
  const tokLabel = tok > 0 ? (tok / 1000).toFixed(1) + "M tok/day" : "None";
  const time = c.lastRun ? new Date(c.lastRun).toLocaleString() : "Never";
  const ago = c.lastRun ? timeAgo(c.lastRun) : "";
  const lines = (c.lastLines || "").trim();

  const rows: [string, string, string?][] = [
    ["Schedule", c.hour || "N/A"],
    ["Status", c.enabled !== false ? "Enabled" : "Disabled", c.enabled !== false ? "#4ade80" : "#f87171"],
    ["Auto-fix", c.autoFix ? "Yes" : "No", c.autoFix ? "#4ade80" : "var(--muted)"],
    ["Token budget", `${tokLabel}${c.cost ? ` (${c.cost[3]}K/agent x ${c.cost[1]} apps x ${c.cost[2]} runs)` : ""}`],
    ["Log file", c.log || "N/A"],
    ["Last run", `${time}${ago ? ` (${ago})` : ""}`],
  ];

  const btnStyle: React.CSSProperties = {
    flex: 1, padding: 8, border: "1px solid var(--border)", borderRadius: 6,
    background: "none", color: "#fff", fontFamily: "inherit", fontSize: 11,
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  };

  return (
    <div style={{
      background: "#161616", border: "1px solid var(--border)", borderRadius: 12,
      width: "90%", maxWidth: 520, maxHeight: "80vh", overflowY: "auto",
      boxShadow: "0 16px 48px rgba(0,0,0,0.5)", color: "#fff",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 20px 16px", borderBottom: "1px solid var(--border)" }}>
        <AgentAvatar id={c.id} size={40} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color }}>{taskName(c)}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>{c.desc || ""}</div>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 18, cursor: "pointer", padding: 4, lineHeight: 1 }}
        >
          &times;
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: "16px 20px 20px" }}>
        {rows.map(([label, value, clr]) => (
          <div key={label} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)",
          }}>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)" }}>{label}</span>
            <span style={{
              fontSize: label === "Log file" ? 10 : 12,
              color: clr || "#fff", fontWeight: 500, textAlign: "right",
            }}>
              {value}
            </span>
          </div>
        ))}
        {lines && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontWeight: 600, marginBottom: 6 }}>RECENT OUTPUT</div>
            <div style={{
              background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", borderRadius: 6,
              padding: "8px 10px", fontSize: 10, color: "rgba(255,255,255,0.8)",
              maxHeight: 160, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
              lineHeight: 1.5, fontFamily: "'SF Mono','Fira Code',monospace",
            }}>
              {lines}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
        <button onClick={() => onRun(c.id)} style={btnStyle}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          Run Now
        </button>
        <button onClick={() => onViewLog(c.id)} style={btnStyle}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
          Full Log
        </button>
        <button onClick={() => onClearLog(c.id)} style={{ ...btnStyle, color: "var(--down)" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          Clear Log
        </button>
      </div>
    </div>
  );
}
