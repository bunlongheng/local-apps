"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import AppIcon from "@/components/AppIcon";
import { fetchJSON } from "@/lib/api";

/* ---------- types ---------- */
interface AppEntry {
  id: string;
  name?: string;
}

interface AppIndex {
  desktop?: string[];
  mobile?: string[];
  screenshots?: string[]; // legacy flat format
}

type RetakeMap = Record<string, boolean>;
type GifList = string[];

type Mode = "desktop" | "desktop-framed" | "mobile" | "mobile-framed" | "gifs";

/* ---------- component ---------- */
export default function GalleryPage() {
  const [allApps, setAllApps] = useState<AppEntry[]>([]);
  const [appData, setAppData] = useState<Record<string, AppIndex>>({});
  const [gifData, setGifData] = useState<Record<string, GifList>>({});
  const [retakeData, setRetakeData] = useState<Record<string, RetakeMap>>({});
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});

  const [currentApp, setCurrentApp] = useState<string | null>(null);
  const [currentMode, setCurrentMode] = useState<Mode>("desktop");
  const [hiddenApps, setHiddenApps] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);

  const [lbOpen, setLbOpen] = useState(false);
  const [lbIdx, setLbIdx] = useState(0);

  const [retakeRunning, setRetakeRunning] = useState(false);
  const [retakeBtnText, setRetakeBtnText] = useState("Retake");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ---- helpers ---- */
  const isNewFormat = (id: string) => {
    const d = appData[id];
    return d && (d.desktop || d.mobile);
  };

  const getShots = useCallback(
    (id: string, mode: Mode): string[] => {
      if (mode === "gifs") return gifData[id] || [];
      const d = appData[id];
      if (!d) return [];
      if (d.desktop || d.mobile) {
        if (mode === "desktop" || mode === "desktop-framed") return d.desktop || [];
        if (mode === "mobile" || mode === "mobile-framed") return d.mobile || [];
        return [];
      }
      return mode === "desktop" ? d.screenshots || [] : [];
    },
    [appData, gifData],
  );

  const shotUrl = useCallback(
    (id: string, mode: Mode, filename: string) => {
      if (mode === "gifs") return `/screenshots/${id}/gifs/${filename}`;
      if (isNewFormat(id)) return `/screenshots/${id}/${mode}/${filename}`;
      return `/screenshots/${id}/${filename}`;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appData],
  );

  const currentShots = currentApp ? getShots(currentApp, currentMode) : [];

  /* ---- init ---- */
  useEffect(() => {
    setHiddenApps(JSON.parse(localStorage.getItem("gallery-hidden") || "[]"));
  }, []);

  useEffect(() => {
    (async () => {
      const [idx, status] = await Promise.all([
        fetchJSON<AppEntry[]>("/screenshots/index.json").catch(() => []),
        fetchJSON<{ apps: { id: string; status: string }[] }>("/api/status").catch(() => ({ apps: [] })),
      ]);

      const sm: Record<string, string> = {};
      (status.apps || []).forEach((a: { id: string; status: string }) => (sm[a.id] = a.status));
      setStatusMap(sm);

      const apps = Array.isArray(idx) ? idx : [];
      setAllApps(apps);

      const ad: Record<string, AppIndex> = {};
      const gd: Record<string, GifList> = {};
      const rd: Record<string, RetakeMap> = {};

      await Promise.all(
        apps.map(async (a) => {
          try {
            ad[a.id] = await fetchJSON<AppIndex>(`/screenshots/${a.id}/index.json`);
          } catch {}
          try {
            rd[a.id] = await fetchJSON<RetakeMap>(`/api/retake/${a.id}`);
          } catch {
            rd[a.id] = {};
          }
          try {
            const g = await fetchJSON<{ gifs?: string[] }>(`/screenshots/${a.id}/gifs/index.json`);
            gd[a.id] = g.gifs || [];
          } catch {
            gd[a.id] = [];
          }
        }),
      );

      setAppData(ad);
      setGifData(gd);
      setRetakeData(rd);

      const params = new URLSearchParams(window.location.search);
      const paramApp = params.get("app");
      const paramMode = params.get("mode") as Mode | null;
      const validModes: Mode[] = ["desktop", "desktop-framed", "mobile", "mobile-framed", "gifs"];
      const defaultApp = paramApp && apps.find((a) => a.id === paramApp) ? paramApp : apps[0]?.id;
      if (defaultApp) setCurrentApp(defaultApp);
      if (paramMode && validModes.includes(paramMode)) setCurrentMode(paramMode);
    })();
  }, []);

  /* ---- sync URL params ---- */
  useEffect(() => {
    if (!currentApp) return;
    const params = new URLSearchParams(window.location.search);
    params.set("app", currentApp);
    params.set("mode", currentMode);
    const url = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", url);
  }, [currentApp, currentMode]);

  /* ---- sidebar actions ---- */
  const toggleHideApp = (id: string) => {
    setHiddenApps((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem("gallery-hidden", JSON.stringify(next));
      return next;
    });
  };

  /* ---- retake / delete ---- */
  const toggleRetake = async (filename: string) => {
    if (!currentApp) return;
    try {
      const r = await fetch("/api/retake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: currentApp, mode: currentMode, filename }),
      }).then((res) => res.json());

      const marked = !!r.marked;
      setRetakeData((prev) => {
        const key = `${currentMode}/${filename}`;
        const appMap = { ...(prev[currentApp!] || {}) };
        if (marked) appMap[key] = true;
        else delete appMap[key];
        return { ...prev, [currentApp!]: appMap };
      });
    } catch {}
  };

  const deleteShot = async (filename: string) => {
    if (!currentApp || !confirm(`Delete ${filename}?`)) return;
    await fetch("/api/screenshot", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: currentApp, mode: currentMode, filename }),
    }).catch(() => {});

    setAppData((prev) => {
      const d = { ...prev[currentApp!] };
      const modeKey = currentMode.includes("mobile") ? "mobile" : currentMode.includes("desktop") ? "desktop" : "screenshots";
      if (Array.isArray(d[modeKey as keyof AppIndex])) {
        (d as Record<string, string[]>)[modeKey] = ((d as Record<string, string[]>)[modeKey] || []).filter((f: string) => f !== filename);
      }
      return { ...prev, [currentApp!]: d };
    });
  };

  /* ---- retake all ---- */
  const retakeAll = async () => {
    if (!currentApp || retakeRunning) return;
    setRetakeRunning(true);
    setRetakeBtnText("Running...");

    try {
      const res = await fetch(`/api/screenshots/${currentApp}`, { method: "POST" });
      const data = await res.json();
      if (data.status === "already_running") {
        setRetakeBtnText("Already running");
      } else {
        setRetakeBtnText("Started");
        pollRef.current = setInterval(async () => {
          const s = await fetch("/api/screenshots-status")
            .then((r) => r.json())
            .catch(() => ({}));
          if (!s[currentApp!]) {
            if (pollRef.current) clearInterval(pollRef.current);
            setRetakeBtnText("Retake");
            setRetakeRunning(false);
            try {
              const d = await fetchJSON<AppIndex>(`/screenshots/${currentApp}/index.json`);
              setAppData((prev) => ({ ...prev, [currentApp!]: d }));
            } catch {}
          }
        }, 3000);
      }
    } catch {
      setRetakeBtnText("Error");
    }
    setTimeout(() => setRetakeRunning(false), 3000);
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /* ---- export PDF ---- */
  const exportPdf = () => {
    if (!currentApp || !currentShots.length) return;
    const name = currentApp;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><title>${name} -- Screenshots</title>
<style>
  @page { size: landscape; margin: 0.5in; }
  @media print { .no-print { display:none; } }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,sans-serif; background:#fff; color:#000; }
  h1 { font-size:20px; margin:20px 0 10px; }
  .meta { font-size:12px; color:#666; margin-bottom:20px; }
  .shot { page-break-inside:avoid; margin-bottom:24px; }
  .shot img { width:100%; max-height:80vh; object-fit:contain; border:1px solid #ddd; border-radius:4px; }
  .shot-name { font-size:11px; color:#888; margin-top:4px; }
  .toolbar { position:fixed; top:10px; right:10px; z-index:100; }
  .toolbar button { padding:8px 20px; font-size:13px; background:#6366f1; color:#fff; border:none; border-radius:6px; cursor:pointer; font-family:inherit; }
</style></head><body>
<div class="toolbar no-print"><button onclick="window.print()">Print / Save PDF</button></div>
<h1>${name}</h1>
<div class="meta">${currentMode} · ${currentShots.length} screenshots · ${new Date().toLocaleDateString()}</div>
${currentShots
  .map(
    (f) =>
      `<div class="shot"><img src="${location.origin}${shotUrl(currentApp, currentMode, f)}"><div class="shot-name">${f.replace(".png", "")}</div></div>`,
  )
  .join("")}
</body></html>`);
    w.document.close();
  };

  /* ---- lightbox keyboard ---- */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!lbOpen) return;
      if (e.key === "Escape") setLbOpen(false);
      if (e.key === "ArrowLeft") setLbIdx((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setLbIdx((i) => Math.min(currentShots.length - 1, i + 1));
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [lbOpen, currentShots.length]);

  /* ---- mode switch: reset to desktop if not new format ---- */
  useEffect(() => {
    if (currentApp && !isNewFormat(currentApp) && currentMode !== "desktop" && currentMode !== "gifs") {
      setCurrentMode("desktop");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentApp]);

  /* ---- derived ---- */
  const shotCount = (id: string) => {
    const d = appData[id] || {};
    const gifs = (gifData[id] || []).length;
    return (d.desktop || d.screenshots || []).length + (d.mobile || []).length + gifs;
  };

  const newFmt = currentApp ? isNewFormat(currentApp) : false;
  const hasGifs = currentApp ? (gifData[currentApp] || []).length > 0 : false;
  const isMobile = currentMode.includes("mobile");
  const thumbClass = isMobile ? "mobile" : "desktop";
  const retakeMap = currentApp ? retakeData[currentApp] || {} : {};

  /* ---------- styles ---------- */
  const S = {
    layout: { display: "flex", height: "calc(100vh)", overflow: "hidden" } as const,
    sidebar: { width: 200, flexShrink: 0, borderRight: "1px solid var(--border)", overflowY: "auto", padding: "12px 8px" } as const,
    sidebarHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 4 } as const,
    sidebarLabel: { fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--muted)", padding: "6px 8px 4px", fontWeight: 600 } as const,
    showHiddenBtn: { fontSize: 10, color: "var(--muted)", padding: "6px 10px", cursor: "pointer", border: "none", background: "none", fontFamily: "inherit" } as const,
    main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" } as const,
    tabs: { display: "flex", gap: 4, padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0, alignItems: "center" } as const,
    gridWrap: { flex: 1, overflowY: "auto", padding: 16 } as const,
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 } as const,
    empty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--muted)", gap: 10 } as const,
  };

  const tabStyle = (mode: Mode, active: boolean) =>
    ({
      background: active ? "#6366f1" : "none",
      border: `1px solid ${active ? "#6366f1" : "var(--border)"}`,
      color: active ? "#fff" : "var(--muted)",
      fontFamily: "inherit",
      fontSize: 11,
      padding: "5px 14px",
      borderRadius: 6,
      cursor: "pointer",
      letterSpacing: "0.02em",
      fontWeight: active ? 600 : 400,
    }) as const;

  /* ---------- render ---------- */
  return (
    <div style={S.layout}>
      {/* App sidebar */}
      <aside style={S.sidebar}>
        <div style={S.sidebarHeader}>
          <div style={S.sidebarLabel}>Apps</div>
          {hiddenApps.length > 0 && (
            <button style={S.showHiddenBtn} onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? "Hide hidden" : `Show hidden (${hiddenApps.length})`}
            </button>
          )}
        </div>
        {allApps
          .filter((a) => showHidden || !hiddenApps.includes(a.id))
          .map((a) => {
            const isHidden = hiddenApps.includes(a.id);
            const active = currentApp === a.id;
            return (
              <AppItem
                key={a.id}
                app={a}
                active={active}
                hidden={isHidden}
                count={shotCount(a.id)}
                onClick={() => setCurrentApp(a.id)}
                onToggleHide={() => toggleHideApp(a.id)}
              />
            );
          })}
      </aside>

      {/* Main area */}
      <div style={S.main}>
        {/* Mode tabs */}
        <div style={S.tabs}>
          <button style={tabStyle("desktop", currentMode === "desktop")} onClick={() => setCurrentMode("desktop")}>
            Desktop
          </button>
          {newFmt && (
            <button style={tabStyle("desktop-framed", currentMode === "desktop-framed")} onClick={() => setCurrentMode("desktop-framed")}>
              MacBook
            </button>
          )}
          {newFmt && <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />}
          {newFmt && (
            <button style={tabStyle("mobile", currentMode === "mobile")} onClick={() => setCurrentMode("mobile")}>
              Mobile
            </button>
          )}
          {newFmt && (
            <button style={tabStyle("mobile-framed", currentMode === "mobile-framed")} onClick={() => setCurrentMode("mobile-framed")}>
              iPhone
            </button>
          )}
          {hasGifs && <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />}
          {hasGifs && (
            <button style={tabStyle("gifs", currentMode === "gifs")} onClick={() => setCurrentMode("gifs")}>
              GIFs
            </button>
          )}
          <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: "auto" }}>
            {currentShots.length ? `${currentShots.length} shots` : ""}
          </span>
          <button
            style={{
              ...tabStyle("desktop", false),
              marginLeft: currentShots.length ? 8 : "auto",
              background: "rgba(74,222,128,0.1)",
              borderColor: "rgba(74,222,128,0.3)",
              color: "#4ade80",
            }}
            disabled={retakeRunning}
            onClick={retakeAll}
          >
            {retakeBtnText}
          </button>
          <button
            style={{
              ...tabStyle("desktop", false),
              background: "rgba(99,102,241,0.1)",
              borderColor: "#6366f1",
              color: "#818cf8",
            }}
            onClick={exportPdf}
          >
            Export PDF
          </button>
        </div>

        {/* Grid */}
        <div style={S.gridWrap}>
          {!currentApp ? (
            <div style={S.empty}>
              <div style={{ fontSize: 40, opacity: 0.3 }}>screenshots</div>
              <div>Select an app to view screenshots</div>
            </div>
          ) : currentShots.length === 0 ? (
            <div style={S.empty}>
              <div style={{ fontSize: 40, opacity: 0.3 }}>--</div>
              <div>No screenshots for this mode</div>
            </div>
          ) : (
            <div style={S.grid}>
              {currentShots.map((f, i) => {
                const key = `${currentMode}/${f}`;
                const isRetake = !!retakeMap[key];
                return (
                  <Thumb
                    key={`${currentApp}-${currentMode}-${f}`}
                    filename={f}
                    src={shotUrl(currentApp, currentMode, f)}
                    isRetake={isRetake}
                    thumbClass={thumbClass}
                    onOpen={() => {
                      setLbIdx(i);
                      setLbOpen(true);
                    }}
                    onRetake={() => toggleRetake(f)}
                    onDelete={() => deleteShot(f)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lbOpen && currentApp && currentShots.length > 0 && (
        <Lightbox
          src={shotUrl(currentApp, currentMode, currentShots[lbIdx])}
          name={currentShots[lbIdx]}
          counter={`${lbIdx + 1} / ${currentShots.length}`}
          hasPrev={lbIdx > 0}
          hasNext={lbIdx < currentShots.length - 1}
          onPrev={() => setLbIdx((i) => Math.max(0, i - 1))}
          onNext={() => setLbIdx((i) => Math.min(currentShots.length - 1, i + 1))}
          onClose={() => setLbOpen(false)}
        />
      )}
    </div>
  );
}

/* ---------- sub-components ---------- */

function AppItem({
  app,
  active,
  hidden,
  count,
  onClick,
  onToggleHide,
}: {
  app: AppEntry;
  active: boolean;
  hidden: boolean;
  count: number;
  onClick: () => void;
  onToggleHide: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const name = app.name || app.id;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "8px 10px",
        borderRadius: 8,
        cursor: "pointer",
        border: active ? "1px solid var(--border)" : "1px solid transparent",
        background: active ? "#20243a" : hovered ? "var(--surface)" : "transparent",
        opacity: hidden ? 0.3 : 1,
        transition: "background 0.1s",
      }}
    >
      <AppIcon id={app.id} name={name} size={20} />
      <span style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: "auto" }}>{count || ""}</span>
      {hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleHide();
          }}
          title={hidden ? "Unhide" : "Hide"}
          style={{
            background: "none",
            border: "none",
            color: "var(--muted)",
            cursor: "pointer",
            fontSize: 11,
            padding: "2px 4px",
            borderRadius: 4,
            lineHeight: 1,
          }}
        >
          {hidden ? "+" : "\u2715"}
        </button>
      )}
    </div>
  );
}

function Thumb({
  filename,
  src,
  isRetake,
  thumbClass,
  onOpen,
  onRetake,
  onDelete,
}: {
  filename: string;
  src: string;
  isRetake: boolean;
  thumbClass: string;
  onOpen: () => void;
  onRetake: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isMobile = thumbClass === "mobile";
  const aspectRatio = isMobile ? "9/19.5" : "16/10";
  const objectFit = "cover" as const;
  const imgBg = "#111";

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: 8,
        overflow: "hidden",
        cursor: "pointer",
        border: `1px solid ${isRetake ? "#f59e0b" : hovered ? "#818cf8" : "var(--border)"}`,
        background: "var(--surface)",
        position: "relative",
        transition: "all 0.15s",
        transform: hovered ? "translateY(-2px)" : "none",
        boxShadow: hovered ? "0 8px 24px rgba(0,0,0,0.4)" : "none",
      }}
    >
      {isRetake && (
        <span
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            background: "#f59e0b",
            color: "#000",
            fontSize: 9,
            fontWeight: 800,
            padding: "2px 7px",
            borderRadius: 5,
            letterSpacing: "0.04em",
            pointerEvents: "none",
            zIndex: 2,
          }}
        >
          RETAKE
        </span>
      )}
      <img
        src={src}
        loading="lazy"
        alt={filename}
        onClick={onOpen}
        onError={(e) => {
          (e.currentTarget.parentElement as HTMLElement).style.display = "none";
        }}
        style={{
          width: "100%",
          display: "block",
          objectFit,
          aspectRatio,
          background: imgBg,
          cursor: "pointer",
        }}
      />
      {hovered && (
        <div style={{ position: "absolute", top: 6, right: 6, display: "flex", flexDirection: "column", gap: 5, zIndex: 2 }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRetake();
            }}
            title="Mark for retake"
            style={{
              border: "none",
              borderRadius: 6,
              width: 28,
              height: 28,
              cursor: "pointer",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: isRetake ? "#78350f" : "rgba(15,17,23,0.82)",
              color: isRetake ? "#fbbf24" : "#94a3b8",
            }}
          >
            &#x21A9;
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete"
            style={{
              border: "none",
              borderRadius: 6,
              width: 28,
              height: 28,
              cursor: "pointer",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(15,17,23,0.82)",
              color: "#94a3b8",
            }}
          >
            &#x2715;
          </button>
        </div>
      )}
      <div
        onClick={onOpen}
        style={{
          padding: "8px 10px",
          fontSize: 10,
          color: "var(--muted)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          borderTop: "1px solid var(--border)",
        }}
      >
        {filename.replace(".png", "")}
      </div>
    </div>
  );
}

function Lightbox({
  src,
  name,
  counter,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
}: {
  src: string;
  name: string;
  counter: string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.92)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <button
        onClick={onClose}
        style={{
          position: "fixed",
          top: 16,
          right: 20,
          background: "rgba(255,255,255,0.1)",
          border: "none",
          color: "#fff",
          width: 34,
          height: 34,
          borderRadius: "50%",
          cursor: "pointer",
          fontSize: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 10,
        }}
      >
        &#x2715;
      </button>

      <button
        onClick={onPrev}
        disabled={!hasPrev}
        style={{
          position: "fixed",
          top: "50%",
          transform: "translateY(-50%)",
          left: 16,
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "#fff",
          width: 44,
          height: 44,
          borderRadius: "50%",
          cursor: hasPrev ? "pointer" : "default",
          fontSize: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: hasPrev ? 1 : 0.2,
          zIndex: 10,
        }}
      >
        &#x2039;
      </button>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflow: "hidden", width: "100%" }}>
        <img
          src={src}
          alt={name}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            borderRadius: 4,
            boxShadow: "0 0 80px rgba(0,0,0,0.8)",
          }}
        />
      </div>

      <button
        onClick={onNext}
        disabled={!hasNext}
        style={{
          position: "fixed",
          top: "50%",
          transform: "translateY(-50%)",
          right: 16,
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "#fff",
          width: 44,
          height: 44,
          borderRadius: "50%",
          cursor: hasNext ? "pointer" : "default",
          fontSize: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: hasNext ? 1 : 0.2,
          zIndex: 10,
        }}
      >
        &#x203A;
      </button>

      <div
        style={{
          height: 52,
          flexShrink: 0,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{name}</span>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>{counter}</span>
      </div>
    </div>
  );
}
