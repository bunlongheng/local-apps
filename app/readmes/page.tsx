"use client";

import { useEffect, useState, useCallback } from "react";
import AppIcon from "@/components/AppIcon";

interface App {
  id: string;
  name: string;
  icon?: string;
  repo?: string;
}

export default function ReadmesPage() {
  const [apps, setApps] = useState<App[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/apps")
      .then((r) => r.json())
      .then((data: App[]) => {
        setApps(data);
        const hash = window.location.hash.slice(1);
        const target =
          hash && data.find((a) => a.id === hash) ? hash : data[0]?.id || null;
        if (target) selectApp(target, data);
      });
  }, []);

  const selectApp = useCallback(
    async (id: string, appList?: App[]) => {
      setActiveId(id);
      setLoading(true);
      setError(false);
      setHtml("");
      window.location.hash = id;

      try {
        const res = await fetch(`/api/readme/${id}`);
        if (!res.ok) throw new Error("No README");
        const data = await res.json();
        setHtml(data.html);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const activeApp = apps.find((a) => a.id === activeId);
  const repo =
    activeApp?.repo || `https://github.com/bunlongheng/${activeId}`;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 24px" }}>
      {/* Header */}
      <header
        style={{
          padding: "20px 0",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <h1
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "#fff",
          }}
        >
          READMEs
        </h1>
        <div
          style={{
            color: "var(--muted)",
            fontSize: 11,
            marginTop: 2,
          }}
        >
          {apps.length > 0 ? `${apps.length} apps` : ""}
        </div>
      </header>

      {/* App tabs */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          padding: "16px 0",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {apps.map((app) => (
          <button
            key={app.id}
            onClick={() => selectApp(app.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 14px",
              borderRadius: 8,
              border:
                activeId === app.id
                  ? "1px solid rgba(255,255,255,0.15)"
                  : "1px solid var(--border)",
              background:
                activeId === app.id
                  ? "rgba(255,255,255,0.08)"
                  : "transparent",
              color: activeId === app.id ? "#fff" : "var(--muted)",
              fontFamily: "inherit",
              fontSize: 11,
              cursor: "pointer",
              fontWeight: activeId === app.id ? 600 : 500,
              transition: "all 0.12s",
            }}
          >
            <AppIcon id={app.id} name={app.name} icon={app.icon} size={20} />
            {app.name || app.id}
          </button>
        ))}
      </div>

      {/* README content */}
      <div style={{ padding: "24px 0 60px" }}>
        {loading && (
          <div
            style={{
              textAlign: "center",
              padding: 60,
              color: "var(--muted)",
              fontStyle: "italic",
            }}
          >
            Loading...
          </div>
        )}

        {error && (
          <div
            style={{
              textAlign: "center",
              padding: 60,
              color: "var(--muted)",
              fontStyle: "italic",
            }}
          >
            No README.md found for this app
          </div>
        )}

        {!loading && !error && !html && !activeId && (
          <div
            style={{
              textAlign: "center",
              padding: 60,
              color: "var(--muted)",
              fontStyle: "italic",
            }}
          >
            Select an app above
          </div>
        )}

        {!loading && !error && html && activeId && (
          <>
            {/* Meta header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 20,
              }}
            >
              <AppIcon
                id={activeId}
                name={activeApp?.name || activeId}
                icon={activeApp?.icon}
                size={36}
              />
              <div>
                <div
                  style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}
                >
                  {activeApp?.name || activeId}
                </div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>
                  <a
                    href={repo}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#818cf8", textDecoration: "none" }}
                  >
                    {repo}
                  </a>
                </div>
              </div>
            </div>

            {/* Rendered README */}
            <div
              className="readme-content"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </>
        )}
      </div>

      <style>{`
        .readme-content {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 32px;
          line-height: 1.7;
        }
        .readme-content h1 {
          font-size: 20px;
          font-weight: 700;
          color: #fff;
          margin-bottom: 16px;
          border-bottom: 1px solid var(--border);
          padding-bottom: 12px;
        }
        .readme-content h2 {
          font-size: 15px;
          font-weight: 700;
          color: #e0e0e0;
          margin-top: 28px;
          margin-bottom: 10px;
        }
        .readme-content h3 {
          font-size: 13px;
          font-weight: 600;
          color: #ccc;
          margin-top: 20px;
          margin-bottom: 8px;
        }
        .readme-content p {
          font-size: 12px;
          color: rgba(255,255,255,0.6);
          margin-bottom: 10px;
        }
        .readme-content ul,
        .readme-content ol {
          font-size: 12px;
          color: rgba(255,255,255,0.6);
          padding-left: 20px;
          margin-bottom: 10px;
        }
        .readme-content li {
          margin-bottom: 4px;
        }
        .readme-content code {
          background: rgba(255,255,255,0.06);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 11px;
          font-family: 'SF Mono', 'Fira Code', monospace;
        }
        .readme-content pre {
          background: rgba(0,0,0,0.4);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 14px 16px;
          margin: 10px 0 16px;
          overflow-x: auto;
        }
        .readme-content pre code {
          background: none;
          padding: 0;
          font-size: 11px;
          color: rgba(255,255,255,0.5);
          line-height: 1.6;
        }
        .readme-content table {
          width: 100%;
          border-collapse: collapse;
          margin: 10px 0 16px;
          font-size: 11px;
        }
        .readme-content th {
          text-align: left;
          padding: 8px 12px;
          border-bottom: 2px solid var(--border);
          color: rgba(255,255,255,0.7);
          font-weight: 600;
        }
        .readme-content td {
          padding: 8px 12px;
          border-bottom: 1px solid var(--border);
          color: rgba(255,255,255,0.5);
        }
        .readme-content hr {
          border: none;
          border-top: 1px solid var(--border);
          margin: 24px 0;
        }
        .readme-content a {
          color: #818cf8;
          text-decoration: none;
        }
        .readme-content a:hover {
          text-decoration: underline;
        }
        .readme-content blockquote {
          border-left: 3px solid rgba(255,255,255,0.1);
          padding-left: 14px;
          color: rgba(255,255,255,0.4);
          margin: 10px 0;
          font-style: italic;
        }
        .readme-content strong {
          color: rgba(255,255,255,0.8);
        }
        .readme-content img {
          max-width: 100%;
          border-radius: 8px;
        }
      `}</style>
    </div>
  );
}
