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
  launchAgent: string | null;
  logPath: string | null;
  startCommand: string | null;
  hostname?: string;
  disabled?: boolean;
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

interface AppCapabilities {
  mcp?: boolean;
  mcpName?: string;
  mcpPath?: string;
  mcpFile?: string;
  api?: boolean;
  cli?: boolean;
  cliBin?: string;
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

function detectAccessMode(): { mode: string; label: string } {
  if (typeof window === "undefined") return { mode: "local", label: "localhost" };
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return { mode: "local", label: "localhost" };
  if (host.endsWith(".localhost")) return { mode: "caddy", label: host };
  if (host.startsWith("10.") || host.startsWith("192.168.")) return { mode: "lan", label: host };
  if (host.startsWith("100.")) return { mode: "tailscale", label: host };
  return { mode: "remote", label: host };
}

type StartupPhase = "wait" | "boot" | "serve-start" | "ready" | "compile" | "serving" | "error";
interface StartupState { phase: StartupPhase; label: string; percent: number; stalled?: boolean }

// Honest, phase-based startup progress from raw log lines (Next.js dev output).
// Later phases win, so we scan all lines and keep the highest-progress marker.
function detectStartupPhase(lines: string[]): StartupState {
  const text = (lines || []).join("\n");
  if (!text.trim()) return { phase: "wait", label: "Starting...", percent: 5 };

  let best: StartupState = { phase: "wait", label: "Starting...", percent: 5 };
  const consider = (s: StartupState) => { if (s.percent >= best.percent) best = s; };

  if (/▲\s*Next\.js|next dev/i.test(text)) consider({ phase: "boot", label: "Booting", percent: 20 });
  if (/-\s*Local:|^\s*Local:/im.test(text)) consider({ phase: "serve-start", label: "Server starting", percent: 45 });
  if (/Ready in|✓\s*Ready/i.test(text)) consider({ phase: "ready", label: "Server ready", percent: 70 });
  if (/○?\s*Compiling/i.test(text)) consider({ phase: "compile", label: "Compiling", percent: 85 });
  if (/✓\s*Compiled|\bGET\b.*\b200\b/i.test(text)) consider({ phase: "serving", label: "Serving", percent: 100 });

  // Errors override but keep the furthest progress reached so the bar shows where it died.
  if (/EADDRINUSE|address already in use|Cannot find module|Failed to compile|^\s*Error:/im.test(text)) {
    return { phase: "error", label: "Error - check log", percent: best.percent };
  }
  return best;
}

// --- App profile (merged in from the former /apps page) ---
interface AppProfile {
  about?: string | null;
  features?: string[] | null;
  architect?: string | null;
  deploy?: string | null;
  security?: string[] | null;
  performance?: string[] | null;
  prompt?: string | null;
}
type ModalTab = "info" | "screenshots" | "about" | "architect" | "deploy" | "security" | "performance";
const PROFILE_TABS: { key: ModalTab; label: string }[] = [
  { key: "info", label: "Info" },
  { key: "screenshots", label: "Screenshots" },
  { key: "about", label: "About" },
  { key: "architect", label: "Architect" },
  { key: "deploy", label: "Deploy" },
  { key: "security", label: "Security" },
  { key: "performance", label: "Performance" },
];

/** Render one profile tab's body (bulleted lists for features/security/perf, prose otherwise). */
function ProfilePanel({ tab, profile }: { tab: ModalTab; profile: AppProfile }) {
  const prose = (v?: string | null, fallback = "Not documented yet.") => (
    <p style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.7, margin: 0 }}>{v || fallback}</p>
  );
  const bullets = (items?: string[] | null, dot = "#3b82f6", fallback = "Not documented yet.") => {
    if (!items || !items.length) return prose(null, fallback);
    return (
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((s, i) => (
          <li key={i} style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.7, padding: "2px 0" }}>
            <span style={{ display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: dot, marginRight: 8, verticalAlign: "middle" }} />
            {s}
          </li>
        ))}
      </ul>
    );
  };
  switch (tab) {
    case "about":
      return (
        <div>
          {prose(profile.about, "No description yet.")}
          <div style={{ marginTop: 10 }}>{bullets(profile.features, "#3b82f6", "")}</div>
        </div>
      );
    case "architect": return prose(profile.architect);
    case "deploy": return prose(profile.deploy);
    case "security": return bullets(profile.security, "#22c55e");
    case "performance": return bullets(profile.performance, "#eab308");
    default: return null;
  }
}

export default function StatusPage() {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<"all" | "up" | "down">("all");
  const [modalApp, setModalApp] = useState<App | null>(null);
  const [modalTab, setModalTab] = useState<ModalTab>("info");
  const [profiles, setProfiles] = useState<Record<string, AppProfile>>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [startingApps, setStartingApps] = useState<Set<string>>(new Set());
  const [startupState, setStartupState] = useState<Record<string, StartupState>>({});
  const startTimes = useRef<Record<string, number>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [activeMachine, setActiveMachine] = useState<string | null>(null);
  const [localInfo, setLocalInfo] = useState<{ hostname?: string; model?: string; ip?: string }>({});
  const [activeInfo, setActiveInfo] = useState<{ hostname?: string; model?: string; ip?: string }>({});
  const [machineOnline, setMachineOnline] = useState<Record<string, boolean>>({});
  const [screenshots, setScreenshots] = useState<Screenshot | null>(null);
  const [screenshotsLoading, setScreenshotsLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [qrData, setQrData] = useState<{ dataUrl: string; url: string } | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<Record<string, AppCapabilities>>({});
  const [iconSync, setIconSync] = useState<Record<string, { hasFavicon: boolean; hasAppIcon: boolean; synced: boolean }>>({});
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

  // Restore persisted machine on mount (URL param > localStorage)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlMachine = params.get("machine");
    if (urlMachine) { setActiveMachine(urlMachine); }
    else {
      const saved = localStorage.getItem("activeMachine");
      if (saved) setActiveMachine(saved);
    }
  }, []);

  // Load app profiles once (about/architect/deploy/security/performance) for the modal tabs.
  useEffect(() => {
    fetch("/api/app-profiles")
      .then((r) => r.json())
      .then((p) => setProfiles(p || {}))
      .catch(() => setProfiles({}));
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
        setActiveInfo({ hostname: m.hostname || m.ip, model: m.model, ip: m.ip });
      } else {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error("fail");
        const data: StatusResponse = await res.json();
        setApps(data.apps);
        const hostname = data.apps[0]?.hostname || "";
        const info = { hostname, model: data.machineModel, ip: data.lanIp };
        setLocalInfo(info);
        setActiveInfo(info);
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

  // Load capabilities + icon sync once
  useEffect(() => {
    fetch("/api/capabilities").then(r => r.json()).then(setCapabilities).catch(() => {});
    fetch("/api/icon-sync").then(r => r.json()).then(setIconSync).catch(() => {});
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
            // Clear starting state + stop log polling when SSE confirms up
            if (msg.status === "up") {
              // Snap to 100% "Ready" briefly before the chip leaves the starting state
              setStartupState((prev) => ({ ...prev, [msg.id]: { phase: "serving", label: "Ready", percent: 100 } }));
              const poll = (window as any).__startPoll?.[msg.id];
              if (poll) { clearInterval(poll); delete (window as any).__startPoll[msg.id]; }
              setTimeout(() => {
                setStartingApps((prev) => { const next = new Set(prev); next.delete(msg.id); return next; });
                delete startTimes.current[msg.id];
              }, 700);
            }
            // Sync modalApp if open for this app
            setModalApp((current) => current?.id === msg.id ? { ...current, status: msg.status } as App : current);
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
  const filteredApps = (filter === "all" ? apps : apps.filter((a) => (filter === "up" ? a.status === "up" : a.status !== "up"))).slice().sort((a, b) => {
    // Disabled always last
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    // Then by status: up first
    const order = { up: 0, starting: 1, unknown: 2, down: 3 };
    return (order[a.status] ?? 2) - (order[b.status] ?? 2);
  });

  const shortHost = (activeInfo.hostname || "").replace(".local", "") || "Local";
  const headerIcon = isTailscale ? "/devices/tailscale.svg" : deviceIcon(activeInfo.model);

  async function handleStart(id: string) {
    setStartingApps((prev) => new Set(prev).add(id));
    setLogLines([]);
    setLogLoading(true);
    startTimes.current[id] = Date.now();
    setStartupState((prev) => ({ ...prev, [id]: { phase: "wait", label: "Starting...", percent: 5 } }));
    try {
      await fetch(`/api/start/${id}`, { method: "POST" });
      // Poll logs while starting
      const pollLog = setInterval(async () => {
        try {
          const r = await fetch(`/api/log/${id}`);
          const d = await r.json();
          const lines: string[] = d.lines || [];
          setLogLines(lines);
          setLogLoading(false);
          // Honest phase + stuck detection (>30s and not yet serving)
          const phase = detectStartupPhase(lines);
          const elapsed = Date.now() - (startTimes.current[id] || Date.now());
          const stalled = elapsed > 30000 && phase.phase !== "serving" && phase.phase !== "error";
          setStartupState((prev) => ({ ...prev, [id]: { ...phase, stalled } }));
          setTimeout(() => {
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
          }, 50);
        } catch {}
      }, 2000);
      // SSE will flip status to "up" - stop polling after 60s max
      setTimeout(() => {
        clearInterval(pollLog);
        setStartingApps((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        delete startTimes.current[id];
      }, 60000);
      // Store interval so SSE can clear it
      (window as any).__startPoll = (window as any).__startPoll || {};
      (window as any).__startPoll[id] = pollLog;
    } catch {
      setStartingApps((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setLogLoading(false);
    }
  }

  async function handleStop(id: string) {
    try {
      await fetch(`/api/stop/${id}`, { method: "POST" });
      setApps((prev) => prev.map((a) => a.id === id ? { ...a, status: "down" as const } : a));
      setModalApp((prev) => prev?.id === id ? { ...prev, status: "down" as const } : prev);
      setToast("Stopped");
      setTimeout(() => setToast(null), 2000);
    } catch {}
  }


  async function handleCapture(id: string) {
    setCapturing(true);
    try {
      await fetch(`/api/screenshots/${id}`, { method: "POST" });
      // Poll for completion
      const poll = setInterval(async () => {
        try {
          const s = await fetch("/api/screenshots-status").then((r) => r.json());
          if (!s[id]) {
            clearInterval(poll);
            setCapturing(false);
            setToast("Screenshots captured");
            setTimeout(() => setToast(null), 3000);
            loadScreenshotsForApp(id);
          }
        } catch {}
      }, 3000);
    } catch {
      setCapturing(false);
      setToast("Capture failed");
      setTimeout(() => setToast(null), 3000);
    }
  }

  function copyToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setToast("Copied");
        setTimeout(() => setToast(null), 1500);
      }).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text: string) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
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
        <div style={{ maxWidth: 900, padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* Left: hamburger (mobile) + device icon + hostname (#9) */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {headerIcon && <img src={headerIcon} width={28} height={28} alt="" style={{ opacity: 0.85 }} className="header-device-icon" />}
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.5px", color: "#fff" }}>{shortHost}</h1>
              {activeInfo.ip && <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, marginTop: 2 }}>{activeInfo.ip}</div>}
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
      <div style={{ maxWidth: 900, padding: "0 24px" }}>
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
                {mIcon && <img src={mIcon} width={14} height={14} alt="" style={{ opacity: 0.7 }} />}
                {mName}
              </button>
            );
          })}
        </div>
      </div>

      {/* Table */}
      <main style={{ maxWidth: 900, padding: "10px 24px" }}>
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
                const bestUrl = isTailscale ? (app.tailscaleUrl || app.lanUrl || "#") : (access.mode === "lan" || access.mode === "remote") ? (app.lanUrl || "#") : (app.localUrl || "#");
                const hostnameUrl = (access.mode === "lan" || access.mode === "remote") ? (app.lanUrl || app.localUrl || "#") : (app.caddyUrl || app.localUrl || "#");
                const lanUrl = isTailscale ? (app.tailscaleUrl || "#") : (app.lanUrl || app.localUrl || "#");
                const isLast = idx === filteredApps.length - 1;
                const openAppModal = () => { setModalTab("info"); setModalApp(app); };
                return (
                  <tr
                    key={app.id}
                    onClick={openAppModal}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openAppModal();
                      }
                    }}
                    style={{ cursor: "pointer", transition: "background 0.1s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                  >
                    <td style={{ padding: "9px 12px", borderBottom: isLast ? "none" : "1px solid var(--border)", verticalAlign: "middle" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span className={`dot ${app.disabled ? 'disabled' : app.status === 'up' ? 'up' : 'starting-up'}`} />
                        <span style={app.disabled ? { filter: "grayscale(1)", opacity: 0.35 } : undefined}>
                          <AppIcon id={app.id} name={app.name} icon={app.icon} size={32} />
                        </span>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                          <a
                            className="app-name"
                            href={bestUrl}
                            target="_blank"
                            rel="noopener"
                            onClick={(e) => e.stopPropagation()}
                            style={{ fontWeight: 600, fontSize: 13, color: app.disabled ? "var(--muted)" : "var(--text)", textDecoration: "none" }}
                          >
                            {app.name}
                          </a>
                          {startingApps.has(app.id) && (() => {
                            const s = startupState[app.id] || { phase: "wait", label: "Starting...", percent: 5 };
                            const tone = s.phase === "error" ? "error" : s.stalled ? "stalled" : s.percent >= 100 ? "done" : "active";
                            return (
                              <div style={{ display: "flex", flexDirection: "column", gap: 3, width: 160 }}>
                                <span className={`phase-chip ${tone}`}>
                                  {tone === "active" && <span className="spin-dot" />}
                                  {s.label}{s.stalled && s.phase !== "error" ? " · taking longer than usual" : ""}
                                </span>
                                <span className={`progress-bar ${tone}`}>
                                  <span className="progress-fill" style={{ width: `${s.percent}%` }} />
                                </span>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </td>
                    <td className="col-hostname" style={{ padding: "9px 12px", borderBottom: isLast ? "none" : "1px solid var(--border)", verticalAlign: "middle", textAlign: "left" }}>
                      <a href={hostnameUrl} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} style={{ color: app.disabled ? "var(--muted)" : "var(--text)", fontSize: 11, textDecoration: "none" }}>
                        {stripProto(hostnameUrl)}
                      </a>
                    </td>
                    <td className="col-lan" style={{ padding: "9px 12px", borderBottom: isLast ? "none" : "1px solid var(--border)", verticalAlign: "middle", textAlign: "left" }}>
                      <a href={lanUrl} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} style={{ color: app.disabled ? "var(--muted)" : "var(--text)", fontSize: 11, textDecoration: "none" }}>
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
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, width: 680, maxWidth: "94vw", minHeight: "min(620px, 82vh)", maxHeight: "85vh", overflowY: "auto", padding: 24, position: "relative" }}>
            {/* Close */}
            <button onClick={() => setModalApp(null)} style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>
              ✕
            </button>

            {/* Header with camera icon (#8) */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={`dot ${modalApp.disabled ? 'disabled' : modalApp.status === 'up' ? 'up' : 'starting-up'}`} />
                <AppIcon id={modalApp.id} name={modalApp.name} icon={modalApp.icon} size={32} />
                <span style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>{modalApp.name}</span>
                {/* Capability badges: MCP / API / CLI + icon sync */}
                {(() => {
                  const caps = capabilities[modalApp.id] || {};
                  const sync = iconSync[modalApp.id];
                  const badges: { label: string; active: boolean; title: string; href?: string }[] = [
                    {
                      label: "MCP",
                      active: !!caps.mcp,
                      title: caps.mcp ? (caps.mcpName ? `MCP Server: ${caps.mcpName}` : "MCP configured") : "No MCP server",
                      href: caps.mcp ? "http://claude.localhost/mcp" : undefined,
                    },
                    {
                      label: "API",
                      active: !!caps.api,
                      title: caps.api ? "API routes available" : "No API routes",
                    },
                    {
                      label: "CLI",
                      active: !!caps.cli,
                      title: caps.cli ? (caps.cliBin ? `CLI: ~/.local/bin/${caps.cliBin}` : "CLI available") : "No CLI",
                    },
                  ];
                  if (sync) {
                    const iconOk = sync.hasFavicon && sync.hasAppIcon && sync.synced;
                    const iconMissing = !sync.hasAppIcon;
                    badges.push({
                      label: "ICON",
                      active: iconOk,
                      title: !sync.hasFavicon ? "No favicon in local-apps" : iconMissing ? "App repo has no icon file" : sync.synced ? "Icon synced with app repo" : "Icon out of sync with app repo",
                    });
                  }
                  return (
                    <div style={{ display: "flex", gap: 3, marginLeft: 4 }}>
                      {badges.map((b) => {
                        const inner = (
                          <span
                            key={b.label}
                            title={b.title}
                            style={{ fontSize: 8, fontWeight: 700, padding: "2px 5px", borderRadius: 3, letterSpacing: "0.04em", cursor: b.href ? "pointer" : "default", transition: "all 0.15s",
                              background: b.active ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.02)",
                              color: b.active ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.12)",
                              border: `1px solid ${b.active ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.06)"}`,
                              boxShadow: b.active ? "0 0 6px rgba(255,255,255,0.08)" : "none",
                            }}
                          >
                            {b.label}
                          </span>
                        );
                        return b.href ? (
                          <a key={b.label} href={b.href} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} style={{ textDecoration: "none" }}>{inner}</a>
                        ) : inner;
                      })}
                    </div>
                  );
                })()}
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

            {/* On/Off toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0 12px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
              <span style={{ fontSize: 10, color: modalApp.disabled ? "var(--down)" : "var(--up)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {modalApp.disabled ? "OFF" : "ON"}
              </span>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const res = await fetch(`/api/apps/${modalApp.id}/toggle`, { method: "POST" });
                    const data = await res.json();
                    setApps((prev) => prev.map((a) => a.id === modalApp.id ? { ...a, disabled: data.disabled } : a));
                    setModalApp((prev) => prev ? { ...prev, disabled: data.disabled } : prev);
                    setToast(data.disabled ? `${modalApp.name} disabled` : `${modalApp.name} enabled`);
                    setTimeout(() => setToast(null), 2000);
                  } catch {}
                }}
                style={{
                  position: "relative", width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", transition: "background 0.2s",
                  background: modalApp.disabled ? "rgba(255,255,255,0.1)" : "#22c55e",
                }}
              >
                <span style={{
                  position: "absolute", top: 2, left: modalApp.disabled ? 2 : 18, width: 16, height: 16, borderRadius: "50%",
                  background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                }} />
              </button>
            </div>

            {/* Tab strip: Info + profile tabs (merged from the former /apps page) */}
            <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", margin: "4px 0 14px", overflowX: "auto" }}>
              {PROFILE_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={(e) => { e.stopPropagation(); setModalTab(t.key); }}
                  style={{
                    background: "none", border: "none", cursor: "pointer", padding: "6px 8px",
                    fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap",
                    color: modalTab === t.key ? "var(--text, #fff)" : "var(--muted)",
                    borderBottom: modalTab === t.key ? "2px solid #3b82f6" : "2px solid transparent",
                    marginBottom: -1,
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Profile tab body (about/architect/deploy/security/performance) */}
            {modalTab !== "info" && (
              <div style={{ padding: "2px 20px 12px" }}>
                <ProfilePanel tab={modalTab} profile={profiles[modalApp.id] || {}} />
              </div>
            )}

            {/* Rows with emoji icons (#11) */}
            {modalTab === "info" && (<>
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
                    extra: modalApp.launchAgent ? (
                      isDown ? (
                        <button
                          onClick={() => handleStart(modalApp.id)}
                          disabled={isStarting}
                          style={{ marginLeft: 8, background: "none", border: "1px solid rgba(150,150,150,0.25)", color: "rgba(180,180,180,0.7)", fontFamily: "inherit", fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: isStarting ? "default" : "pointer", opacity: isStarting ? 0.5 : 1, transition: "all 0.15s" }}
                        >
                          {isStarting ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span className="spin-dot" />Starting</span> : "Start"}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStop(modalApp.id)}
                          style={{ marginLeft: 8, background: "none", border: "1px solid rgba(239,68,68,0.25)", color: "rgba(239,68,68,0.7)", fontFamily: "inherit", fontSize: 10, padding: "3px 10px", borderRadius: 4, cursor: "pointer", transition: "all 0.15s" }}
                        >
                          Stop
                        </button>
                      )
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

            {/* Startup phase + progress (modal) */}
            {startingApps.has(modalApp.id) && (() => {
              const s = startupState[modalApp.id] || { phase: "wait", label: "Starting...", percent: 5 };
              const tone = s.phase === "error" ? "error" : s.stalled ? "stalled" : s.percent >= 100 ? "done" : "active";
              return (
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span className={`phase-chip lg ${tone}`}>
                      {tone === "active" && <span className="spin-dot" />}
                      {s.label}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{s.percent}%</span>
                  </div>
                  {s.stalled && s.phase !== "error" && (
                    <div style={{ fontSize: 10, color: "var(--starting)", marginBottom: 6 }}>Taking longer than usual - it may be stuck.</div>
                  )}
                  <span className={`progress-bar lg ${tone}`}>
                    <span className="progress-fill" style={{ width: `${s.percent}%` }} />
                  </span>
                </div>
              );
            })()}

            {/* Log viewer for down/starting apps */}
            {(modalApp.status === "down" || startingApps.has(modalApp.id)) && modalApp.logPath && (
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
            </>)}

            {/* Screenshots tab (#4) */}
            {modalTab === "screenshots" && !activeMachine && (
              <div style={{ marginTop: 4 }}>
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
        role="status"
        aria-live="polite"
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
        .dot.down { background: var(--down); }
        .dot.starting { background: var(--starting); animation: pulse 1s infinite; }
        .dot.starting-up { background: var(--starting); animation: pulse 1s infinite; }
        .spin-dot { width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid transparent; border-top-color: currentColor; animation: spin 0.6s linear infinite; display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .dot.unknown { background: var(--muted); }
        .dot.disabled { background: var(--muted); opacity: 0.3; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        .app-name:hover { text-decoration: underline !important; }

        /* Startup phase chip + progress bar */
        .phase-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; letter-spacing: 0.02em; color: var(--starting); white-space: nowrap; }
        .phase-chip.lg { font-size: 12px; font-weight: 600; }
        .phase-chip.done { color: var(--up); }
        .phase-chip.error { color: var(--down); }
        .phase-chip.stalled { color: #d9a441; }
        .progress-bar { display: block; height: 3px; width: 100%; border-radius: 3px; background: rgba(255,255,255,0.08); overflow: hidden; }
        .progress-bar.lg { height: 5px; }
        .progress-fill { display: block; height: 100%; border-radius: 3px; background: var(--starting); transition: width 0.5s ease, background 0.3s ease; }
        .progress-bar.done .progress-fill { background: var(--up); }
        .progress-bar.error .progress-fill { background: var(--down); }
        .progress-bar.stalled .progress-fill { background: #b88a35; }

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

        /* Hostname column overflows on iPad-width screens, hide it earlier than LAN */
        @media (max-width: 1024px) {
          .col-hostname { display: none; }
        }
        @media (max-width: 768px) {
          .col-lan, .header-device-icon { display: none; }
        }
      `}</style>
    </>
  );
}
