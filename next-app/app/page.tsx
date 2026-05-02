"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import AppIcon from "@/components/AppIcon";

interface App {
  id: string;
  name: string;
  status: "up" | "down" | "unknown" | "starting";
  healthUrl: string | null;
  localUrl: string | null;
  lanUrl: string | null;
  tailscaleUrl: string | null;
  caddyUrl: string | null;
  prodUrl: string | null;
  repo: string | null;
  icon: string | null;
  noScreenshot: boolean;
  lastChecked: string | null;
  hasScreenshots: boolean;
  launchAgent: boolean;
  logPath: string | null;
  startCommand: string | null;
  hostname?: string;
}

interface StatusResponse {
  apps: App[];
  lanIp: string;
  tailscaleIp: string | null;
  machineModel: string;
}

interface Machine {
  id: string;
  ip: string;
  hostname?: string;
  model?: string;
}

interface Screenshot {
  screenshots?: string[];
  desktop?: string[];
  mobile?: string[];
  capturedAt?: string;
}

interface PortfolioPreview {
  title: string;
  slug: string;
  type: string;
  tags: string[];
  description: string[];
  url: string | null;
  icon: string | null;
  screenshots: { path: string; name: string; type: string }[];
}

interface Companion {
  id: string;
  name: string;
  desc: string;
  path: string;
  proc: string;
  cmd: string;
}

const DROP_COMPANIONS: Companion[] = [
  { id: "drop-menu", name: "Drop Menu", desc: "Electron menu bar", path: "/Users/bheng/Sites/drop/electron", proc: "electron", cmd: "npm start" },
  { id: "drop-dock", name: "Drop Dock", desc: "Native Swift menu bar", path: "/Users/bheng/Sites/drop/native", proc: "DropMenu", cmd: "./DropMenu" },
];

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

function detectAccessMode(): { mode: string; label: string } {
  if (typeof window === "undefined") return { mode: "local", label: "localhost" };
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return { mode: "local", label: "localhost" };
  if (host.endsWith(".localhost")) return { mode: "caddy", label: host };
  if (host.startsWith("10.") || host.startsWith("192.168.")) return { mode: "lan", label: host };
  if (host.startsWith("100.")) return { mode: "tailscale", label: host };
  return { mode: "remote", label: host };
}

export default function StatusPage() {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<"all" | "up" | "down">("all");
  const [modalApp, setModalApp] = useState<App | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [startingApps, setStartingApps] = useState<Set<string>>(new Set());
  const [companionStatus, setCompanionStatus] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [activeMachine, setActiveMachine] = useState<string | null>(null);
  const [localInfo, setLocalInfo] = useState<{ hostname?: string; model?: string; ip?: string }>({});
  const [machineOnline, setMachineOnline] = useState<Record<string, boolean>>({});
  const [screenshots, setScreenshots] = useState<Screenshot | null>(null);
  const [screenshotsLoading, setScreenshotsLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [qrData, setQrData] = useState<{ dataUrl: string; url: string } | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioPreview, setPortfolioPreview] = useState<PortfolioPreview | null>(null);
  const [portfolioPreviewLoading, setPortfolioPreviewLoading] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const qrRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const activeMachineRef = useRef(activeMachine);

  // Keep ref in sync for SSE callback
  useEffect(() => {
    activeMachineRef.current = activeMachine;
  }, [activeMachine]);

  // Restore persisted machine on mount
  useEffect(() => {
    const saved = localStorage.getItem("activeMachine");
    if (saved) setActiveMachine(saved);
  }, []);

  // Persist machine selection
  useEffect(() => {
    localStorage.setItem("activeMachine", activeMachine || "");
  }, [activeMachine]);

  const loadMachines = useCallback(async () => {
    try {
      const res = await fetch("/api/machines");
      const data: Machine[] = await res.json();
      setMachines(data);
    } catch {
      setMachines([]);
    }
  }, []);

  const machinesRef = useRef(machines);
  useEffect(() => { machinesRef.current = machines; }, [machines]);

  const load = useCallback(async () => {
    try {
      if (activeMachineRef.current) {
        const m = machinesRef.current.find((x: Machine) => x.id === activeMachineRef.current);
        if (!m) {
          setActiveMachine(null);
          return;
        }
        const res = await fetch(`/api/machines/${encodeURIComponent(m.id)}/status`);
        if (!res.ok) throw new Error("unreachable");
        const data: StatusResponse = await res.json();
        const rewritten = data.apps.map((a) => ({
          ...a,
          lanUrl: a.localUrl ? a.localUrl.replace("localhost", m.ip) : null,
        }));
        setApps(rewritten);
        setMachineOnline((prev) => ({ ...prev, [m.id]: true }));
        setLocalInfo({ hostname: m.hostname || m.ip, model: m.model, ip: m.ip });
      } else {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error("fail");
        const data: StatusResponse = await res.json();
        setApps(data.apps);
        const hostname = data.apps[0]?.hostname || "";
        setLocalInfo({ hostname, model: data.machineModel, ip: data.lanIp });
      }
      setLoading(false);
      setError(false);
    } catch {
      if (activeMachineRef.current) {
        setMachineOnline((prev) => ({ ...prev, [activeMachineRef.current!]: false }));
      }
      setError(true);
      setLoading(false);
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    loadMachines();
    load();
    const interval = setInterval(load, 15000);
    const machineInterval = setInterval(loadMachines, 30000);
    return () => {
      clearInterval(interval);
      clearInterval(machineInterval);
    };
  }, [load, loadMachines]);

  // Reload when activeMachine changes
  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMachine]);

  // SSE with proper reconnect (#1) — delayed to avoid blocking initial fetch
  useEffect(() => {
    const sseDelay = setTimeout(() => connectSSE(), 3000);
    return () => { clearTimeout(sseDelay); sseRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connectSSE() {
    function connect() {
      const es = new EventSource("/api/events");
      sseRef.current = es;
      es.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "update") {
          if (msg.status === "removed") {
            setApps((prev) => prev.filter((a) => a.id !== msg.id));
          } else {
            setApps((prev) => prev.map((a) => (a.id === msg.id ? { ...a, status: msg.status } : a)));
          }
        }
        if (msg.type === "reload") load();
        if (msg.type === "screenshots_done") {
          // #14 — reload screenshots in modal if open for this app
          setModalApp((current) => {
            if (current?.id === msg.id) {
              loadScreenshotsForApp(msg.id);
            }
            return current;
          });
        }
      };
      es.onerror = () => {
        es.close();
        setTimeout(connect, 3000);
      };
    }
    connect();
  }

  // Load log when modal opens for a down app
  useEffect(() => {
    if (!modalApp || modalApp.status !== "down") {
      setLogLines([]);
      return;
    }
    setLogLoading(true);
    fetch(`/api/log/${modalApp.id}`)
      .then((r) => r.json())
      .then((d) => {
        setLogLines(d.lines || []);
        setLogLoading(false);
        setTimeout(() => {
          if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
        }, 50);
      })
      .catch(() => {
        setLogLines(["(could not read log)"]);
        setLogLoading(false);
      });
  }, [modalApp]);

  // Load screenshots when modal opens
  useEffect(() => {
    if (!modalApp || activeMachine) {
      setScreenshots(null);
      return;
    }
    loadScreenshotsForApp(modalApp.id);
  }, [modalApp, activeMachine]);

  function loadScreenshotsForApp(id: string) {
    setScreenshotsLoading(true);
    Promise.all([
      fetch(`/api/screenshots/${id}`).then((r) => r.json()),
      fetch("/api/screenshots-status").then((r) => r.json()).catch(() => ({})),
    ])
      .then(([data, statusRes]) => {
        setScreenshots(data);
        setCapturing(!!statusRes[id]);
        setScreenshotsLoading(false);
      })
      .catch(() => {
        setScreenshots(null);
        setScreenshotsLoading(false);
      });
  }

  // Check companion status when modal opens for Drop
  useEffect(() => {
    if (modalApp?.id !== "drop") return;
    for (const c of DROP_COMPANIONS) {
      fetch(`/api/process-check/${c.proc}`)
        .then((r) => r.json())
        .then((d) => setCompanionStatus((prev) => ({ ...prev, [c.id]: !!d.running })))
        .catch(() => {});
    }
  }, [modalApp]);

  // Close QR on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (qrOpen && qrRef.current && !qrRef.current.contains(e.target as Node)) {
        setQrOpen(false);
      }
    }
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [qrOpen]);

  const access = detectAccessMode();
  const isTailscale = access.mode === "tailscale";
  const upCount = apps.filter((a) => a.status === "up").length;
  const downCount = apps.filter((a) => a.status !== "up").length;
  const filteredApps = filter === "all" ? apps : apps.filter((a) => (filter === "up" ? a.status === "up" : a.status !== "up"));

  const shortHost = (localInfo.hostname || "").replace(".local", "") || "Local";
  const headerIcon = isTailscale ? "/devices/tailscale.svg" : deviceIcon(localInfo.model);

  async function handleStart(id: string) {
    setStartingApps((prev) => new Set(prev).add(id));
    try {
      await fetch(`/api/start/${id}`, { method: "POST" });
      setTimeout(() => {
        setStartingApps((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        load();
      }, 4000);
    } catch {
      setStartingApps((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function toggleCompanion(c: Companion) {
    const running = companionStatus[c.id];
    setCompanionStatus((prev) => ({ ...prev, [c.id]: !running }));
    try {
      if (running) {
        await fetch(`/api/process-kill/${c.proc}`, { method: "POST" });
        setCompanionStatus((prev) => ({ ...prev, [c.id]: false }));
      } else {
        await fetch("/api/companion-start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: c.path, cmd: c.cmd, log: `/tmp/${c.id}.log` }),
        });
        setCompanionStatus((prev) => ({ ...prev, [c.id]: true }));
      }
    } catch {
      setCompanionStatus((prev) => ({ ...prev, [c.id]: running ?? false }));
    }
  }

  async function handleCapture(id: string) {
    setCapturing(true);
    try {
      await fetch(`/api/screenshots/${id}`, { method: "POST" });
    } catch {
      setCapturing(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setToast("Copied");
    setTimeout(() => setToast(null), 1500);
  }

  async function handleAddToPortfolio(appId: string) {
    setPortfolioPreviewLoading(true);
    try {
      const res = await fetch(`/api/portfolio/preview?appId=${encodeURIComponent(appId)}`);
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error || "Preview failed");
        setTimeout(() => setToast(null), 3000);
      } else {
        setPortfolioPreview(data);
      }
    } catch {
      setToast("Preview request failed");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setPortfolioPreviewLoading(false);
    }
  }

  async function handleConfirmPortfolio() {
    if (!portfolioPreview) return;
    setPortfolioLoading(true);
    try {
      const res = await fetch("/api/portfolio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: portfolioPreview.slug }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error || "Portfolio failed");
      } else {
        setToast(`Added to portfolio (${data.images} images)`);
      }
    } catch {
      setToast("Portfolio request failed");
    } finally {
      setPortfolioLoading(false);
      setPortfolioPreview(null);
      setTimeout(() => setToast(null), 3000);
    }
  }

  function getPort(url: string | null): string | null {
    if (!url) return null;
    try {
      return new URL(url).port || null;
    } catch {
      return null;
    }
  }

  async function toggleQR(e: React.MouseEvent) {
    e.stopPropagation();
    if (qrOpen) {
      setQrOpen(false);
      return;
    }
    if (!qrData) {
      try {
        const data = await fetch("/api/qr").then((r) => r.json());
        setQrData(data);
      } catch {
        return;
      }
    }
    setQrOpen(true);
  }

  function switchMachine(id: string | null) {
    setActiveMachine(id);
  }

  const stripProto = (u: string) => u.replace(/^https?:\/\//, "");

  // Row emojis for modal (#11)
  const ROW_EMOJI: Record<string, string> = {
    Port: "\u{1F50C}",
    Local: "\u{1F310}",
    LAN: "\u{1F4E1}",
    Tailscale: "\u{1F517}",
    Caddy: "\u{1F3E0}",
    Prod: "\u{1F680}",
    GitHub: "\u{1F419}",
    Screenshots: "\u{1F4F8}",
  };

  return (
    <>
      {/* Header */}
      <header style={{ padding: "20px 0", borderBottom: "1px solid var(--border)" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* Left: device icon + hostname (#9) */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {headerIcon && <img src={headerIcon} width={28} height={28} alt="" style={{ opacity: 0.85 }} />}
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.5px", color: "#fff" }}>{shortHost}</h1>
              {localInfo.ip && <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, marginTop: 2 }}>{localInfo.ip}</div>}
            </div>
          </div>

          {/* Center: counters */}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 8, fontSize: 18, fontWeight: 800, letterSpacing: "-0.5px", background: "rgba(34,197,94,0.1)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.2)" }}>
              {upCount}
            </div>
            {downCount > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 8, fontSize: 18, fontWeight: 800, letterSpacing: "-0.5px", background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
                {downCount}
              </div>
            )}
          </div>

          {/* Right: help + QR (#6, #7) */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => setHelpOpen(true)}
              title="Quick Reference"
              style={{ background: "none", border: "1px solid var(--border)", color: "var(--muted)", width: 28, height: 28, borderRadius: "50%", cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--text)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--muted)"; }}
            >
              ?
            </button>
            <div style={{ position: "relative" }} ref={qrRef}>
              <button
                onClick={toggleQR}
                title="Show LAN QR code"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, opacity: qrOpen ? 1 : 0.35, transition: "opacity 0.15s" }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseLeave={(e) => { if (!qrOpen) e.currentTarget.style.opacity = "0.35"; }}
              >
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <rect x="1" y="1" width="8" height="8" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
                  <rect x="3.5" y="3.5" width="3" height="3" fill="white" />
                  <rect x="13" y="1" width="8" height="8" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
                  <rect x="15.5" y="3.5" width="3" height="3" fill="white" />
                  <rect x="1" y="13" width="8" height="8" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
                  <rect x="3.5" y="15.5" width="3" height="3" fill="white" />
                  <rect x="13" y="13" width="2.5" height="2.5" fill="white" />
                  <rect x="16.5" y="13" width="2.5" height="2.5" fill="white" />
                  <rect x="13" y="16.5" width="2.5" height="2.5" fill="white" />
                  <rect x="16.5" y="16.5" width="2.5" height="2.5" fill="white" />
                </svg>
              </button>
              {qrOpen && qrData && (
                <div style={{ position: "absolute", right: 0, top: 36, background: "var(--surface)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, padding: 12, zIndex: 150, textAlign: "center", boxShadow: "0 0 0 1px rgba(255,255,255,0.08),0 0 24px rgba(255,255,255,0.12),0 8px 32px rgba(0,0,0,0.6)" }}>
                  <img src={qrData.dataUrl} alt="QR" style={{ width: 168, height: 168, borderRadius: 8, display: "block" }} />
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 10, wordBreak: "break-all", width: 168 }}>{qrData.url}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Machine tabs (#3) */}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
          <button
            onClick={() => switchMachine(null)}
            className={`machine-tab${!activeMachine ? " active" : ""}`}
          >
            {deviceIcon(localInfo.model) && <img src={deviceIcon(localInfo.model)!} width={14} height={14} alt="" style={{ opacity: 0.7 }} />}
            {(localInfo.hostname || "").replace(".local", "") || "Local"}
          </button>
          {machines.map((m) => {
            const mIcon = deviceIcon(m.model);
            const mName = (m.hostname || m.ip).replace(".local", "");
            const online = machineOnline[m.id] !== false;
            return (
              <button
                key={m.id}
                onClick={() => switchMachine(m.id)}
                className={`machine-tab${activeMachine === m.id ? " active" : ""}`}
              >
                <span className={`tab-dot ${online ? "online" : "offline"}`} />
                {mIcon && <img src={mIcon} width={14} height={14} alt="" style={{ opacity: 0.7 }} />}
                {mName}
              </button>
            );
          })}
        </div>
      </div>

      {/* Table */}
      <main style={{ maxWidth: 900, margin: "0 auto", padding: "10px 24px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th style={{ width: "38%", textAlign: "left", padding: "8px 12px", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>App</th>
              <th style={{ width: "22%", textAlign: "left", padding: "8px 12px", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }} className="col-hostname">Hostname</th>
              <th style={{ width: "20%", textAlign: "left", padding: "8px 12px", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }} className="col-lan">LAN</th>
              <th style={{ width: "20%", textAlign: "center", padding: "8px 12px", color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>Loading...</td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
                  {activeMachine ? "Machine unreachable — retrying..." : "Monitor unreachable — retrying..."}
                </td>
              </tr>
            )}
            {!loading && !error && filteredApps.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>No apps</td>
              </tr>
            )}
            {!loading &&
              !error &&
              filteredApps.map((app, idx) => {
                const bestUrl = isTailscale ? (app.tailscaleUrl || app.localUrl || "#") : (app.localUrl || "#");
                const hostnameUrl = app.caddyUrl || app.localUrl || "#";
                const lanUrl = isTailscale ? (app.tailscaleUrl || "#") : (app.lanUrl || app.localUrl || "#");
                const isLast = idx === filteredApps.length - 1;
                return (
                  <tr
                    key={app.id}
                    onClick={() => setModalApp(app)}
                    style={{ cursor: "pointer", transition: "background 0.1s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                  >
                    <td style={{ padding: "9px 12px", borderBottom: isLast ? "none" : "1px solid var(--border)", verticalAlign: "middle" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span className={`dot ${app.status}`} />
                        <AppIcon id={app.id} name={app.name} icon={app.icon} size={32} />
                        <a
                          className="app-name"
                          href={bestUrl}
                          target="_blank"
                          rel="noopener"
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontWeight: 600, fontSize: 13, color: "var(--text)", textDecoration: "none" }}
                        >
                          {app.name}
                        </a>
                      </div>
                    </td>
                    <td className="col-hostname" style={{ padding: "9px 12px", borderBottom: isLast ? "none" : "1px solid var(--border)", verticalAlign: "middle", textAlign: "left" }}>
                      <a href={hostnameUrl} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} style={{ color: "var(--text)", fontSize: 11, textDecoration: "none" }}>
                        {stripProto(hostnameUrl)}
                      </a>
                    </td>
                    <td className="col-lan" style={{ padding: "9px 12px", borderBottom: isLast ? "none" : "1px solid var(--border)", verticalAlign: "middle", textAlign: "left" }}>
                      <a href={lanUrl} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} style={{ color: "var(--text)", fontSize: 11, textDecoration: "none" }}>
                        {stripProto(lanUrl)}
                      </a>
                    </td>
                    <td style={{ padding: "9px 12px", borderBottom: isLast ? "none" : "1px solid var(--border)", verticalAlign: "middle", textAlign: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
                        {/* Tailscale icon (#10) */}
                        {isTailscale && (
                          <a
                            href={app.tailscaleUrl || "#"}
                            target="_blank"
                            rel="noopener"
                            onClick={(e) => e.stopPropagation()}
                            title="Tailscale"
                            style={{ textDecoration: "none", opacity: app.tailscaleUrl ? 0.5 : 0.1, transition: "opacity 0.15s", display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6 }}
                            onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.opacity = app.tailscaleUrl ? "0.5" : "0.1"; e.currentTarget.style.background = "none"; }}
                          >
                            <img src="/devices/tailscale.svg" width={16} height={16} alt="Tailscale" style={{ opacity: 0.85 }} />
                          </a>
                        )}
                        <a
                          href={app.prodUrl || "#"}
                          target="_blank"
                          rel="noopener"
                          onClick={(e) => e.stopPropagation()}
                          title="Vercel"
                          style={{ textDecoration: "none", opacity: app.prodUrl ? 0.5 : 0.1, transition: "opacity 0.15s", display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 6 }}
                          onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.opacity = app.prodUrl ? "0.5" : "0.1"; e.currentTarget.style.background = "none"; }}
                        >
                          <svg width="14" height="14" viewBox="0 0 76 65" fill="white">
                            <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
                          </svg>
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </main>

      {/* Modal */}
      {modalApp && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalApp(null); }}
          onKeyDown={(e) => { if (e.key === "Escape") setModalApp(null); }}
        >
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, width: 680, maxWidth: "94vw", maxHeight: "85vh", overflowY: "auto", padding: 24, position: "relative" }}>
            {/* Close */}
            <button onClick={() => setModalApp(null)} style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>
              ✕
            </button>

            {/* Header with camera icon (#8) */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={`dot ${modalApp.status}`} />
                <AppIcon id={modalApp.id} name={modalApp.name} icon={modalApp.icon} size={32} />
                <span style={{ fontSize: 16, fontWeight: 700 }}>{modalApp.name}</span>
                {modalApp.hasScreenshots && (
                  <a
                    href={`/gallery?app=${modalApp.id}`}
                    target="_blank"
                    rel="noopener"
                    onClick={(e) => e.stopPropagation()}
                    title="Screenshots"
                    style={{ textDecoration: "none", opacity: 0.4, transition: "opacity 0.15s", display: "inline-flex", alignItems: "center", marginLeft: 8 }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.4")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            {modalApp.lastChecked && (
              <div style={{ color: "var(--muted)", fontSize: 9, marginTop: -12, marginBottom: 16, paddingLeft: 20 }}>
                {new Date(modalApp.lastChecked).toLocaleString()}
              </div>
            )}

            {/* Rows with emoji icons (#11) */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {(() => {
                const port = getPort(modalApp.localUrl);
                const isDown = modalApp.status === "down";
                const isStarting = startingApps.has(modalApp.id);

                const rows: { label: string; value: string; url?: string; extra?: React.ReactNode }[] = [];

                if (port) {
                  rows.push({
                    label: "Port",
                    value: port,
                    extra:
                      isDown && modalApp.launchAgent ? (
                        <button
                          onClick={() => handleStart(modalApp.id)}
                          disabled={isStarting}
                          style={{ marginLeft: 8, background: "none", border: "1px solid rgba(150,150,150,0.25)", color: "rgba(180,180,180,0.7)", fontFamily: "inherit", fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: isStarting ? "default" : "pointer", opacity: isStarting ? 0.5 : 1, transition: "all 0.15s" }}
                        >
                          {isStarting ? "Starting..." : "Start"}
                        </button>
                      ) : undefined,
                  });
                }
                if (modalApp.localUrl) rows.push({ label: "Local", value: modalApp.localUrl, url: modalApp.localUrl });
                if (modalApp.lanUrl) rows.push({ label: "LAN", value: modalApp.lanUrl, url: modalApp.lanUrl });
                if (modalApp.tailscaleUrl) rows.push({ label: "Tailscale", value: modalApp.tailscaleUrl, url: modalApp.tailscaleUrl });
                if (modalApp.caddyUrl) rows.push({ label: "Caddy", value: modalApp.caddyUrl, url: modalApp.caddyUrl });
                if (modalApp.prodUrl) rows.push({ label: "Prod", value: modalApp.prodUrl.replace("https://", ""), url: modalApp.prodUrl });
                if (modalApp.repo) rows.push({ label: "GitHub", value: modalApp.repo.replace("https://github.com/", ""), url: modalApp.repo });
                // Screenshots gallery link row (#5)
                if (modalApp.hasScreenshots) rows.push({ label: "Screenshots", value: "View Gallery", url: `/gallery?app=${modalApp.id}` });

                return rows.map((r, i) => {
                  const emoji = ROW_EMOJI[r.label] || "";
                  const isLast = i === rows.length - 1;
                  return (
                    <div key={r.label} style={{ display: "flex", alignItems: "center", padding: "10px 0", borderBottom: isLast ? "none" : "1px solid var(--border)", gap: 16 }}>
                      <span style={{ color: "var(--muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap", flexShrink: 0, width: 110 }}>
                        {emoji ? `${emoji} ` : ""}{r.label}
                      </span>
                      <span style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>
                        {r.url ? (
                          <a href={r.url} target="_blank" rel="noopener" style={{ color: "var(--accent)", textDecoration: "none" }}>
                            {r.value}
                          </a>
                        ) : (
                          <span>
                            {r.value}
                            {r.extra}
                          </span>
                        )}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); copyToClipboard(r.url || r.value); }}
                        style={{ width: 28, height: 28, background: "none", border: "none", cursor: "pointer", flexShrink: 0, opacity: 0.4, transition: "opacity 0.15s", padding: 0, marginLeft: 8 }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.4")}
                        title="Copy"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaaaaa" strokeWidth="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Companion apps for Drop */}
            {modalApp.id === "drop" && (
              <div style={{ marginTop: 2, paddingTop: 10 }}>
                <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Companion Apps</div>
                {DROP_COMPANIONS.map((c) => {
                  const running = companionStatus[c.id] ?? false;
                  return (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      <div>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{c.name}</span>
                        <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{c.desc}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className={`dot ${running ? "up" : "down"}`} style={{ width: 6, height: 6 }} />
                        <button
                          onClick={() => toggleCompanion(c)}
                          style={{ background: "none", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}
                        >
                          {running ? "Stop" : "Start"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Log viewer for down apps */}
            {modalApp.status === "down" && modalApp.logPath && (
              <div style={{ position: "relative", marginTop: 8 }}>
                <button
                  onClick={() => copyToClipboard(logLines.join("\n"))}
                  style={{ position: "absolute", top: 8, right: 8, background: "rgba(255,255,255,0.08)", border: "1px solid var(--border)", color: "var(--muted)", fontFamily: "inherit", fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: "pointer", zIndex: 1, transition: "all 0.15s" }}
                >
                  Copy
                </button>
                <div
                  ref={logRef}
                  style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", fontSize: 10, fontFamily: "'SF Mono','Fira Code',monospace", color: "var(--muted)", maxHeight: 160, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {logLoading ? "Loading log..." : logLines.length ? logLines.join("\n") : "(no log output)"}
                </div>
              </div>
            )}

            {/* Screenshots in modal (#4) */}
            {!activeMachine && (
              <div style={{ marginTop: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 14, borderTop: "1px solid var(--border)" }}>
                  <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", fontWeight: 600 }}>
                    Screenshots
                    {screenshots?.screenshots?.length ? ` (${screenshots.screenshots.length})` : ""}
                    {screenshots?.capturedAt ? ` \u00B7 ${new Date(screenshots.capturedAt).toLocaleString()}` : ""}
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => handleAddToPortfolio(modalApp.id)}
                      disabled={portfolioPreviewLoading || !(screenshots?.desktop?.length || screenshots?.mobile?.length || screenshots?.screenshots?.length)}
                      style={{ background: "none", border: `1px solid ${(screenshots?.desktop?.length || screenshots?.mobile?.length) ? "rgba(59,130,246,0.4)" : "rgba(255,255,255,0.06)"}`, color: (screenshots?.desktop?.length || screenshots?.mobile?.length) ? "rgba(59,130,246,0.9)" : "var(--muted)", fontFamily: "inherit", fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: portfolioPreviewLoading || !(screenshots?.desktop?.length || screenshots?.mobile?.length || screenshots?.screenshots?.length) ? "default" : "pointer", opacity: portfolioPreviewLoading || !(screenshots?.desktop?.length || screenshots?.mobile?.length || screenshots?.screenshots?.length) ? 0.4 : 1, transition: "all 0.15s" }}
                      title={!(screenshots?.desktop?.length || screenshots?.mobile?.length || screenshots?.screenshots?.length) ? "Capture screenshots first" : ""}
                    >
                      {portfolioPreviewLoading ? "Loading..." : "Add to Portfolio"}
                    </button>
                    <button
                      onClick={() => handleCapture(modalApp.id)}
                      disabled={capturing}
                      style={{ background: "none", border: "1px solid rgba(139,92,246,0.4)", color: "rgba(139,92,246,0.9)", fontFamily: "inherit", fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: capturing ? "default" : "pointer", opacity: capturing ? 0.5 : 1, transition: "all 0.15s" }}
                    >
                      {capturing ? "Running..." : "Capture"}
                    </button>
                  </div>
                </div>
                {screenshotsLoading ? (
                  <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 10, textAlign: "center", padding: "20px 0" }}>Loading screenshots...</div>
                ) : screenshots?.screenshots?.length ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginTop: 10 }}>
                    {screenshots.screenshots.map((file) => {
                      const src = `/screenshots/${modalApp.id}/${file}`;
                      const label = file.replace(".png", "").replace(/^\d+-/, "").replace(/-/g, " ");
                      return (
                        <div key={file}>
                          <img
                            src={src}
                            alt={label}
                            loading="lazy"
                            onClick={(e) => { e.stopPropagation(); setLightboxSrc(src); }}
                            style={{ borderRadius: 6, border: "1px solid var(--border)", cursor: "pointer", transition: "all 0.15s", width: "100%", aspectRatio: "16/9", objectFit: "cover", background: "#000" }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.3)"; e.currentTarget.style.transform = "scale(1.02)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.transform = "scale(1)"; }}
                          />
                          <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 3, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 10, textAlign: "center", padding: "20px 0" }}>
                    No screenshots yet — click Capture to generate
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Help modal (#7) */}
      {helpOpen && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setHelpOpen(false); }}
        >
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, width: 680, maxWidth: "94vw", maxHeight: "85vh", overflowY: "auto", padding: 24, position: "relative" }}>
            <button onClick={() => setHelpOpen(false)} style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>
              ✕
            </button>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <h2 style={{ fontSize: 15, fontWeight: 700 }}>AI Instruction</h2>
              <button
                onClick={() => {
                  const el = document.getElementById("helpAIBlock");
                  if (el) copyToClipboard(el.textContent || "");
                }}
                style={{ background: "rgba(255,255,255,0.08)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", fontSize: 11, padding: "5px 14px", borderRadius: 6, cursor: "pointer", transition: "all 0.15s", fontWeight: 600 }}
              >
                Copy
              </button>
            </div>
            <div
              id="helpAIBlock"
              style={{ background: "rgba(0,0,0,0.4)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", fontSize: 11, fontFamily: "'SF Mono','Fira Code',monospace", color: "#a5b4fc", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5 }}
            >{`Register this app with the local-apps monitor.
Include ALL fields so the Apps page is fully populated.

POST http://localhost:9876/api/apps
Content-Type: application/json

Required:
- "id": app slug (lowercase, kebab-case)
- "name": display name
- "localPath": absolute path to project root

Infrastructure (auto-generated if omitted):
- "localUrl": defaults to next available port
- "healthUrl": defaults to localUrl
- "repo": GitHub URL
- "startCommand": defaults to "npm run dev"
- "logPath": defaults to /tmp/{id}.log
- "prodUrl": production URL
- "noScreenshot": skip screenshots (boolean)

App Profile (AI should generate these):
- "about": one compelling sentence describing the app
- "features": JSON array of 3-5 top features
- "architect": paragraph on tech stack and architecture
- "deploy": paragraph on how to deploy and run
- "security": JSON array of 3-4 security measures
- "performance": JSON array of 3-4 performance optimizations
- "prompt": Gemini image gen prompt for the app icon
  Format: "Design a 1024x1024 app icon for [name].
  [2-3 sentences describing visual]. Dark background
  with rounded iOS corners. No text, no watermark."

The monitor will automatically:
1. Assign a dedicated port if not provided
2. Create a Caddy reverse proxy at http://{id}.localhost
3. Create a macOS LaunchAgent plist
4. Begin health-checking every 10s
5. Show app on all dashboard pages with full profile

Example:
curl -X POST http://localhost:9876/api/apps \\
  -H "Content-Type: application/json" \\
  -d '{
  "id":"my-app",
  "name":"My App",
  "localPath":"/path/to/my-app",
  "repo":"https://github.com/bunlongheng/my-app",
  "about":"A powerful tool that does amazing things.",
  "features":["Feature one","Feature two","Feature three"],
  "architect":"Built with Next.js 16, React 19, TypeScript, and Tailwind. Uses SQLite for persistence.",
  "deploy":"Run npm install && npm run dev. Deployed to Vercel on push to main.",
  "security":["Security headers on all responses","Auth required for admin routes"],
  "performance":["Server components by default","Lazy-loaded heavy dependencies"],
  "prompt":"Design a 1024x1024 app icon for My App. A glowing cube with circuit lines. Blue palette on dark background. Rounded iOS corners. No text, no watermark."
}'`}</div>
            {/* Delete app */}
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <button
                onClick={async () => {
                  if (!modalApp) return;
                  if (!confirm(`Delete "${modalApp.name}" and all its data? This removes:\n• Database entry\n• LaunchAgent\n• Caddy proxy\n• Screenshots\n• Kills running process\n\nThis cannot be undone.`)) return;
                  try {
                    const appId = modalApp.id;
                    const r = await fetch(`/api/apps/${appId}`, { method: "DELETE" });
                    if (r.ok) {
                      setApps((prev) => prev.filter((a) => a.id !== appId));
                      setModalApp(null);
                      setToast(`${modalApp.name} deleted`); setTimeout(() => setToast(null), 3000);
                    } else {
                      const d = await r.json().catch(() => ({}));
                      setToast(`Error: ${d.error || "Delete failed"}`); setTimeout(() => setToast(null), 3000);
                    }
                  } catch { setToast("Delete failed"); setTimeout(() => setToast(null), 3000); }
                }}
                style={{ background: "none", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", fontFamily: "inherit", fontSize: 10, padding: "5px 14px", borderRadius: 4, cursor: "pointer", transition: "all 0.15s" }}
              >
                Delete App
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox (#16) */}
      {lightboxSrc && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}
          onClick={() => setLightboxSrc(null)}
        >
          <img src={lightboxSrc} alt="" style={{ maxWidth: "92vw", maxHeight: "92vh", borderRadius: 8, boxShadow: "0 0 40px rgba(0,0,0,0.5)" }} />
        </div>
      )}

      {/* Portfolio Preview Modal */}
      {portfolioPreview && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", backdropFilter: "blur(6px)", zIndex: 350, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setPortfolioPreview(null); }}
          onKeyDown={(e) => { if (e.key === "Escape") setPortfolioPreview(null); }}
        >
          <div style={{ background: "#12141a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, width: 780, maxWidth: "96vw", maxHeight: "90vh", overflowY: "auto", position: "relative" }}>
            {/* Header */}
            <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {portfolioPreview.icon && (
                  <img src={portfolioPreview.icon} width={28} height={28} alt="" style={{ borderRadius: 6 }} />
                )}
                <span style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{portfolioPreview.title}</span>
                <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 4, background: "rgba(59,130,246,0.15)", color: "rgba(59,130,246,0.9)", textTransform: "capitalize" }}>
                  {portfolioPreview.type}
                </span>
              </div>
              <button onClick={() => setPortfolioPreview(null)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>
                ✕
              </button>
            </div>

            <div style={{ display: "flex", gap: 0 }}>
              {/* Left: Screenshots */}
              <div style={{ flex: "1 1 55%", padding: 20, borderRight: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", marginBottom: 10 }}>
                  Screenshots ({portfolioPreview.screenshots.length})
                </div>
                {portfolioPreview.screenshots.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 8 }}>
                    {portfolioPreview.screenshots.map((s) => {
                      const label = s.name.replace(".png", "").replace(/^\d+-/, "").replace(/-/g, " ");
                      return (
                        <div key={s.path}>
                          <img
                            src={s.path}
                            alt={label}
                            loading="lazy"
                            style={{ width: "100%", aspectRatio: s.type === "mobile-framed" ? "9/16" : "16/9", objectFit: "cover", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", background: "#000" }}
                          />
                          <div style={{ fontSize: 8, color: "var(--muted)", marginTop: 3, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {s.type === "mobile-framed" ? "M" : "D"} - {label}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ color: "var(--muted)", fontSize: 11, textAlign: "center", padding: "30px 0" }}>No framed screenshots</div>
                )}
              </div>

              {/* Right: Fields */}
              <div style={{ flex: "1 1 45%", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Tags */}
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", marginBottom: 6 }}>Tags</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {portfolioPreview.tags.length > 0 ? portfolioPreview.tags.map((tag) => {
                      const colors: Record<string, string> = {
                        "Next.js": "#0070f3", "React": "#61dafb", "TypeScript": "#3178c6", "Tailwind": "#38bdf8",
                        "Supabase": "#3ecf8e", "Node.js": "#68a063", "Express": "#ffffff", "SQLite": "#003b57",
                        "Electron": "#9feaf9", "Vite": "#646cff", "Python": "#3776ab", "Rust": "#dea584",
                      };
                      const c = colors[tag] || "#a78bfa";
                      return (
                        <span key={tag} style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: `${c}20`, color: c, border: `1px solid ${c}30` }}>
                          {tag}
                        </span>
                      );
                    }) : (
                      <span style={{ fontSize: 10, color: "var(--muted)" }}>No tags detected</span>
                    )}
                  </div>
                </div>

                {/* Description */}
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", marginBottom: 6 }}>Description</div>
                  <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: "10px 12px", fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.5 }}>
                    {portfolioPreview.description.map((line, i) => (
                      <div key={i} style={{ marginBottom: i === 0 ? 8 : 2 }}>
                        {i === 0 ? line : `\u2022 ${line}`}
                      </div>
                    ))}
                  </div>
                </div>

                {/* URL */}
                {portfolioPreview.url && (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", marginBottom: 6 }}>Production URL</div>
                    <a href={portfolioPreview.url} target="_blank" rel="noopener" style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}>
                      {portfolioPreview.url}
                    </a>
                  </div>
                )}

                {/* Slug */}
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", marginBottom: 6 }}>Slug</div>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "'SF Mono','Fira Code',monospace" }}>{portfolioPreview.slug}</span>
                </div>
              </div>
            </div>

            {/* Footer buttons */}
            <div style={{ padding: "16px 24px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                onClick={() => setPortfolioPreview(null)}
                style={{ background: "none", border: "1px solid rgba(255,255,255,0.15)", color: "var(--muted)", fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "8px 20px", borderRadius: 6, cursor: "pointer", transition: "all 0.15s" }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPortfolio}
                disabled={portfolioLoading}
                style={{ background: "rgba(59,130,246,0.9)", border: "none", color: "#fff", fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "8px 20px", borderRadius: 6, cursor: portfolioLoading ? "default" : "pointer", opacity: portfolioLoading ? 0.6 : 1, transition: "all 0.15s" }}
              >
                {portfolioLoading ? "Uploading..." : "Confirm & Post"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      <div
        style={{
          position: "fixed",
          bottom: 32,
          left: "50%",
          transform: `translateX(-50%) translateY(${toast ? 0 : 20}px)`,
          background: "#22c55e",
          color: "#fff",
          padding: "10px 20px",
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 700,
          opacity: toast ? 1 : 0,
          transition: "all 0.2s",
          pointerEvents: "none",
          zIndex: 10000,
        }}
      >
        {toast || "Copied"}
      </div>

      {/* Styles */}
      <style>{`
        .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
        .dot.up { background: var(--up); box-shadow: 0 0 6px 1px rgba(74,222,128,0.5); }
        .dot.down { background: var(--down); box-shadow: 0 0 6px 1px rgba(248,113,113,0.5); animation: pulse 1.5s infinite; }
        .dot.starting { background: var(--starting); box-shadow: 0 0 6px 1px rgba(250,204,21,0.5); animation: pulse 1s infinite; }
        .dot.unknown { background: var(--muted); }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        .app-name:hover { text-decoration: underline !important; }

        /* Filter bar (#2) */
        .filter-btn { background: none; border: 1px solid var(--border); color: var(--muted); font-family: inherit; font-size: 11px; padding: 4px 12px; border-radius: 20px; cursor: pointer; transition: all 0.15s; letter-spacing: 0.04em; }
        .filter-btn:hover { border-color: var(--text); color: var(--text); }
        .filter-btn.active { background: var(--accent); color: #0f1117; border-color: var(--accent); font-weight: 600; }
        .filter-btn.active-up { background: var(--up); color: #0f1117; border-color: var(--up); font-weight: 600; }
        .filter-btn.active-down { background: var(--down); color: #fff; border-color: var(--down); font-weight: 600; }

        /* Machine tabs (#3) */
        .machine-tab { display: flex; align-items: center; gap: 6px; background: none; border: 1px solid var(--border); color: var(--muted); font-family: inherit; font-size: 11px; padding: 5px 12px; border-radius: 20px; cursor: pointer; transition: all 0.15s; }
        .machine-tab:hover { border-color: var(--text); color: var(--text); }
        .machine-tab.active { background: rgba(255,255,255,0.08); border-color: var(--text); color: #fff; font-weight: 600; }
        .tab-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
        .tab-dot.online { background: var(--up); box-shadow: 0 0 4px rgba(74,222,128,0.5); }
        .tab-dot.offline { background: var(--down); }

        @media (max-width: 768px) {
          .col-hostname, .col-lan { display: none; }
        }
      `}</style>
    </>
  );
}
