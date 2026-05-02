"use client";

import { useEffect, useState, useCallback } from "react";
import AppIcon from "@/components/AppIcon";
import { fetchJSON, AppStatus } from "@/lib/api";

/* ---------- types ---------- */
interface AppProfile {
  about?: string;
  features?: string[];
  architect?: string;
  deploy?: string;
  security?: string[];
  performance?: string[];
  prompt?: string;
}

const TABS = ["about", "architect", "deploy", "security", "performance", "prompt"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  about: "ABOUT",
  architect: "ARCHITECT",
  deploy: "DEPLOY",
  security: "SECURITY",
  performance: "PERFORMANCE",
  prompt: "PROMPT",
};

/* ---------- built-in prompts (fallback) ---------- */
const PROMPTS: Record<string, string> = {
  tools: 'Design a 1024x1024 app icon for "Tools", a collection of 30+ developer utilities. A pixelated Swiss Army knife with colorful rainbow tools (wrench, pliers, blade, terminal) fanning out. Dark carbon fiber background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  diagrams: 'Design a 1024x1024 app icon for "Diagrams", a sequence diagram and visual workflow tool. Show a vertical sequence diagram with colored lifeline bars (purple, cyan, pink) connected by horizontal arrow messages flowing between them. Deep purple (#8B5CF6) gradient fading to violet background with rounded iOS corners. Add glowing neon connection lines and small colored dots at intersection points. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  claude: 'Design a 1024x1024 app icon for "Claude Dashboard", an AI session and memory manager. A gold hexagon containing a circuit-board brain with glowing nodes, bar charts and pie chart accents. Dark charcoal background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  stickies: 'Design a 1024x1024 app icon for "Stickies", a collaborative sticky notes board. Stacked yellow sticky notes with a red pushpin, checkmark, and colorful small cards. Warm orange background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  mindmaps: 'Design a 1024x1024 app icon for "Mindmaps", a visual mind mapping tool. A glowing central node with radiating branches like a neuron, small colored dots at endpoints. Indigo (#6366F1) to purple gradient background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  safe: 'Design a 1024x1024 app icon for "Safe", a local secrets manager. A steel shield with a vault dial and green (#22C55E) glowing key slot. Dark gunmetal background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  drop: 'Design a 1024x1024 app icon for "Drop", a LAN file transfer app. A parachute dropping a package box with motion lines. Green (#16A34A) to teal gradient background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  "ai-spinner": 'Design a 1024x1024 app icon for "AI Spinner", an AI activity indicator. A glowing neon atom with orbiting rings in pink (#F92672), yellow (#E6DB74), cyan (#66D9EF) with a bright core. Dark space/navy background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  moments: 'Design a 1024x1024 app icon for "Moments", a digital photo frame app. A gold camera aperture blending into a picture frame with a warm sunset inside. Dark black background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  frames: 'Design a 1024x1024 app icon for "Frames", a device mockup generator. Overlapping silver Apple device silhouettes - MacBook, iPhone, iPad. Dark (#0E0E10) background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  bheng: 'Design a 1024x1024 app icon for "bheng", a developer portfolio. Minimalist letter B stylized as a code bracket with electric blue glow. Black background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  audit: 'Design a 1024x1024 app icon for "Audit", a GitHub repo analyzer that generates diagrams instantly. A magnifying glass over a code repository structure with Mermaid-style flowchart lines radiating out. Red (#DC2626) and dark charcoal palette with glowing scan lines. Dark background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  workflows: 'Design a 1024x1024 app icon for "Workflows", a visual drag-and-drop automation builder. Connected workflow nodes with curved bezier lines flowing left to right, glowing connection points. Cyan (#06B6D4) and electric blue palette on a dark background. Rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  "system-design": 'Design a 1024x1024 app icon for "System Design", an interactive architecture diagram tool for AWS and distributed systems. Show cloud infrastructure icons (server, database, load balancer) connected by network lines in a layered architecture. Purple (#B45CF6) and orange accent palette on a dark background. Rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  "kactus-qa": 'Design a 1024x1024 app icon for "KACTUS QA", a QA testing dashboard. A cactus silhouette made of geometric shapes with a small checkmark badge in the bottom-right corner. Dark green (#166534) gradient background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  "local-apps": 'Design a 1024x1024 app icon for "Local Apps", a process manager and monitoring dashboard. A grid of 4 small rounded squares (2x2) in different muted colors (teal, purple, amber, coral) representing multiple apps, with thin connection lines between them. Dark charcoal (#1a1a1a) background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  clip: 'Design a 1024x1024 app icon for "Clip", a clipboard history and media clip manager. A paperclip shape merged with a play button triangle, suggesting media clipping. Deep indigo (#312E81) gradient background with rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  "cl-poster": 'Design a 1024x1024 app icon for "idesign4u", a Craigslist post manager with automated weekly rotation. A classified ad card with a refresh/rotation arrow looping around it, suggesting auto-reposting. Amber (#F59E0B) and warm orange palette on a dark charcoal background. Rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
  pixel: 'Design a 1024x1024 app icon for "Pixel", a visual regression testing tool. A magnifying glass over two overlapping screenshots with a red diff highlight between them. Electric purple (#8B5CF6) and cyan palette on a dark background. Rounded iOS corners. No white background, no border, no text, no watermark. Single centered icon, clean edges.',
};

/* ---------- copy SVG icon ---------- */
function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/* ---------- toast ---------- */
function Toast({ message, visible }: { message: string; visible: boolean }) {
  if (!message) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 20,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        pointerEvents: "none",
        animation: visible ? "islandIn 0.3s cubic-bezier(0.16,1,0.3,1) forwards" : "islandOut 0.25s ease-in forwards",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 14px 6px 10px",
          borderRadius: 20,
          background: "#34C759",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "inherit",
          boxShadow: "0 8px 26px rgba(52,199,89,0.4)",
          border: "1px solid rgba(52,199,89,0.6)",
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
        {message}
      </div>
    </div>
  );
}

/* ---------- tab panel content ---------- */
function PanelContent({ app, profile, tab }: { app: AppStatus; profile: AppProfile; tab: Tab }) {
  switch (tab) {
    case "about": {
      const about = profile.about || "A powerful local-first app.";
      const features = profile.features || [];
      return (
        <>
          <div style={{ fontSize: 13, color: "var(--text, #e4e4e7)", fontWeight: 500, marginBottom: 10, lineHeight: 1.5 }}>{about}</div>
          {features.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
              {features.map((f, i) => (
                <li key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.7, padding: "2px 0" }}>
                  <span style={{ display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: "#3b82f6", marginRight: 8, verticalAlign: "middle" }} />
                  {f}
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case "architect":
      return <p style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.7 }}>{profile.architect || "Architecture details coming soon."}</p>;
    case "deploy":
      return <p style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.7 }}>{profile.deploy || "Deploy details coming soon."}</p>;
    case "security": {
      const items = profile.security || [];
      if (!items.length) return <p style={{ fontSize: 11, color: "var(--muted, #71717a)", lineHeight: 1.7 }}>Security details coming soon.</p>;
      return (
        <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
          {items.map((s, i) => (
            <li key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.7, padding: "2px 0" }}>
              <span style={{ display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: "#22c55e", marginRight: 8, verticalAlign: "middle" }} />
              {s}
            </li>
          ))}
        </ul>
      );
    }
    case "performance": {
      const items = profile.performance || [];
      if (!items.length) return <p style={{ fontSize: 11, color: "var(--muted, #71717a)", lineHeight: 1.7 }}>Performance details coming soon.</p>;
      return (
        <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
          {items.map((p, i) => (
            <li key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.7, padding: "2px 0" }}>
              <span style={{ display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: "#eab308", marginRight: 8, verticalAlign: "middle" }} />
              {p}
            </li>
          ))}
        </ul>
      );
    }
    case "prompt": {
      const text = profile.prompt || PROMPTS[app.id] || "";
      if (!text) return <p style={{ fontSize: 11, color: "var(--muted, #71717a)" }}>No prompt yet</p>;
      return <p style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.7 }}>{text}</p>;
    }
  }
}

/* ---------- get plain text for copy ---------- */
function getPanelText(app: AppStatus, profile: AppProfile, tab: Tab): string {
  switch (tab) {
    case "about": {
      const about = profile.about || "";
      const features = (profile.features || []).join("\n- ");
      return about + (features ? "\n\n- " + features : "");
    }
    case "prompt":
      return profile.prompt || PROMPTS[app.id] || "";
    case "architect":
      return profile.architect || "";
    case "deploy":
      return profile.deploy || "";
    case "security":
      return (profile.security || []).join("\n");
    case "performance":
      return (profile.performance || []).join("\n");
  }
}

/* ---------- single card ---------- */
function AppCard({
  app,
  profile,
  onCopy,
}: {
  app: AppStatus;
  profile: AppProfile;
  onCopy: (text: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("about");

  const handleCopy = useCallback(() => {
    const text = getPanelText(app, profile, activeTab);
    if (text) {
      navigator.clipboard.writeText(text).then(() => onCopy("Copied to clipboard"));
    }
  }, [app, profile, activeTab, onCopy]);

  const desc = (profile.about || "").substring(0, 60);

  return (
    <div
      style={{
        background: "var(--surface, #18181b)",
        border: "1px solid var(--border, #27272a)",
        borderRadius: 12,
        overflow: "hidden",
        transition: "border-color 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border, #27272a)")}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 18px", borderBottom: "1px solid var(--border, #27272a)" }}>
        <AppIcon id={app.id} name={app.name} icon={app.icon} size={48} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{app.name}</div>
          {desc && <div style={{ fontSize: 11, color: "var(--muted, #71717a)", marginTop: 2 }}>{desc}</div>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border, #27272a)", overflowX: "auto" }}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              background: "none",
              border: "none",
              borderBottom: `2px solid ${activeTab === t ? "#fff" : "transparent"}`,
              color: activeTab === t ? "#fff" : "var(--muted, #71717a)",
              fontFamily: "inherit",
              fontSize: 10,
              fontWeight: 600,
              padding: "8px 12px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              transition: "all 0.12s",
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Panel */}
      <div
        style={{ position: "relative", padding: "14px 18px", minHeight: 120 }}
        className="panel-hover"
      >
        <button
          onClick={handleCopy}
          className="copy-icon-btn"
          title="Copy"
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid var(--border, #27272a)",
            color: "var(--muted, #71717a)",
            width: 26,
            height: 26,
            borderRadius: 5,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.12s",
            opacity: 0,
          }}
        >
          <CopyIcon />
        </button>
        <PanelContent app={app} profile={profile} tab={activeTab} />
      </div>
    </div>
  );
}

/* ---------- page ---------- */
export default function AppsPage() {
  const [apps, setApps] = useState<AppStatus[]>([]);
  const [profiles, setProfiles] = useState<Record<string, AppProfile>>({});
  const [toast, setToast] = useState({ message: "", visible: false });

  useEffect(() => {
    async function load() {
      const appList = await fetchJSON<AppStatus[]>("/api/apps").catch(() => []);
      setApps(appList);

      const p = await fetchJSON<Record<string, AppProfile>>("/api/app-profiles").catch(() => ({}));
      setProfiles(p);
    }
    load();
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast({ message: msg, visible: true });
    setTimeout(() => setToast((t) => ({ ...t, visible: false })), 2000);
    setTimeout(() => setToast({ message: "", visible: false }), 2300);
  }, []);

  return (
    <>
      <style>{`
        @keyframes islandIn {
          0% { transform: translateX(-50%) translateY(-20px) scale(0.8); opacity: 0; }
          100% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; }
        }
        @keyframes islandOut {
          0% { opacity: 1; transform: translateX(-50%) scale(1); }
          100% { opacity: 0; transform: translateX(-50%) scale(0.8) translateY(-10px); }
        }
        .panel-hover:hover .copy-icon-btn { opacity: 1 !important; }
        .copy-icon-btn:hover { background: rgba(255,255,255,0.12) !important; color: var(--text, #e4e4e7) !important; border-color: var(--text, #e4e4e7) !important; }
      `}</style>

      <div style={{ padding: 32 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 24, color: "#fff" }}>Apps</h1>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
          {apps.map((app) => (
            <AppCard key={app.id} app={app} profile={profiles[app.id] || {}} onCopy={showToast} />
          ))}
        </div>
      </div>

      <Toast message={toast.message} visible={toast.visible} />
    </>
  );
}
