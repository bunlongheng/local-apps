"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";

const NAV_ITEMS = [
  {
    href: "/",
    label: "Status",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    href: "/routines",
    label: "Routines",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
  {
    href: "/loops",
    label: "Loops",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="17 1 21 5 17 9" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 23 3 19 7 15" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
    ),
  },
  {
    href: "/gallery",
    label: "Screenshots",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    ),
  },
  {
    href: "/docs",
    label: "API Docs",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    ),
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("sidebar-collapsed") === "true";
    if (saved) {
      setCollapsed(true);
      document.documentElement.style.setProperty("--sidebar-w", "52px");
    }
  }, []);

  return (
    <>
      {/* Mobile hamburger — visible globally */}
      <button
        onClick={() => setOpen(!open)}
        aria-label="Menu"
        className="hamburger-btn"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {open ? (
            <>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </>
          ) : (
            <>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </>
          )}
        </svg>
      </button>

      {/* Overlay */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 99,
          }}
          className="sidebar-overlay"
        />
      )}

      {/* Sidebar */}
      <nav className={`sidebar-nav-root ${open ? "open" : ""}`}>
        <div
          style={{
            padding: 16,
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {!collapsed && <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 500, letterSpacing: "0.02em" }}>
            Local Apps
          </span>}
        </div>
        <div style={{ padding: "12px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
          {NAV_ITEMS.map((item) => {
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  borderRadius: 7,
                  fontSize: 12,
                  color: isActive ? "#fff" : "var(--muted)",
                  textDecoration: "none",
                  fontWeight: isActive ? 600 : 500,
                  background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
                  transition: "all 0.12s",
                }}
              >
                <span style={{ opacity: isActive ? 0.9 : 0.45, flexShrink: 0 }}>{item.icon}</span>
                {!collapsed && item.label}
              </Link>
            );
          })}
        </div>
        <div
          style={{
            marginTop: "auto",
            padding: "8px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "space-between",
          }}
        >
          {!collapsed && <span style={{ fontSize: 10, color: "var(--muted)", padding: "0 8px" }}>localhost:9876</span>}
          <button
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              localStorage.setItem("sidebar-collapsed", String(next));
              document.documentElement.style.setProperty("--sidebar-w", next ? "52px" : "200px");
            }}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {collapsed ? <polyline points="9 18 15 12 9 6" /> : <polyline points="15 18 9 12 15 6" />}
            </svg>
          </button>
        </div>
      </nav>

      <style>{`
        .sidebar-nav-root {
          position: fixed;
          top: 0;
          left: 0;
          bottom: 0;
          width: var(--sidebar-w, 200px);
          background: #111;
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          z-index: 100;
          transition: transform 0.2s ease;
        }
        .hamburger-btn {
          display: none;
          background: none;
          border: none;
          color: var(--text);
          cursor: pointer;
          padding: 4px;
          line-height: 1;
          width: 24px;
          height: 24px;
          flex-shrink: 0;
        }
        @media (max-width: 768px) {
          .sidebar-nav-root {
            transform: translateX(-100%);
          }
          .sidebar-nav-root.open {
            transform: translateX(0);
          }
          .hamburger-btn {
            display: flex;
            align-items: center;
            justify-content: center;
          }
        }
      `}</style>
    </>
  );
}
