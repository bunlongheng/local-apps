"use client";

import { useState, useCallback } from "react";

/* ── method badge colors ── */
const METHOD_COLORS: Record<string, { bg: string; color: string }> = {
  GET: { bg: "rgba(74,222,128,0.15)", color: "#4ade80" },
  POST: { bg: "rgba(250,204,21,0.15)", color: "#facc15" },
  PUT: { bg: "rgba(96,165,250,0.15)", color: "#60a5fa" },
  DELETE: { bg: "rgba(248,113,113,0.15)", color: "#f87171" },
};

/* ── types ── */
interface Param {
  name: string;
  type: string;
  required: boolean;
  desc: string;
}

interface Endpoint {
  method: string;
  path: string;
  desc: string;
  body?: string;
  params?: Param[];
  example?: string;
  tryUrl?: string;
  tryLabel?: string;
}

interface Category {
  title: string;
  endpoints: Endpoint[];
}

/* ── endpoint data (mirrors docs.html) ── */
const CATEGORIES: Category[] = [
  {
    title: "Apps -- CRUD",
    endpoints: [
      {
        method: "GET",
        path: "/api/apps",
        desc: "List all apps",
        body: "Returns array of all registered apps.",
        tryUrl: "/api/apps",
      },
      {
        method: "GET",
        path: "/api/apps/:id",
        desc: "Get one app",
        body: "Returns a single app by ID.",
      },
      {
        method: "POST",
        path: "/api/apps",
        desc: "Register new app",
        body: "Register a new app. Auto-creates: port assignment, Caddy proxy, LaunchAgent, health check.",
        params: [
          { name: "id", type: "string", required: true, desc: "Unique app identifier (kebab-case)" },
          { name: "name", type: "string", required: false, desc: "Display name (defaults to id)" },
          { name: "localPath", type: "string", required: false, desc: "Absolute path to project root" },
          { name: "localUrl", type: "string", required: false, desc: "Auto-assigned if omitted" },
          { name: "healthUrl", type: "string", required: false, desc: "Defaults to localUrl" },
          { name: "repo", type: "string", required: false, desc: "GitHub repo URL" },
          { name: "startCommand", type: "string", required: false, desc: 'Defaults to "npm run dev"' },
          { name: "icon", type: "string", required: false, desc: "URL/path to app icon" },
          { name: "logPath", type: "string", required: false, desc: "Defaults to /tmp/{id}.log" },
        ],
        example: `curl -X POST http://localhost:9876/api/apps \\
  -H "Content-Type: application/json" \\
  -d '{"id":"my-app","localPath":"/Users/me/Sites/my-app"}'`,
      },
      {
        method: "PUT",
        path: "/api/apps/:id",
        desc: "Update app",
        body: "Update any fields on an existing app. Only provided fields are changed.",
        example: `curl -X PUT http://localhost:9876/api/apps/my-app \\
  -H "Content-Type: application/json" \\
  -d '{"localUrl":"http://localhost:4000","icon":"/favicons/my-app.svg"}'`,
      },
      {
        method: "DELETE",
        path: "/api/apps/:id",
        desc: "Remove app + teardown infra",
        body: "Deletes app from DB, removes Caddy entry, and unloads LaunchAgent.",
        example: `curl -X DELETE http://localhost:9876/api/apps/my-app`,
      },
    ],
  },
  {
    title: "Status & Monitoring",
    endpoints: [
      {
        method: "GET",
        path: "/api/status",
        desc: "Dashboard status (all apps + machine info)",
        body: "Returns all apps with live status, LAN URLs, machine hostname, model, and IP.",
        tryUrl: "/api/status",
      },
      {
        method: "GET",
        path: "/api/events",
        desc: "SSE stream (live updates)",
        body: "Server-Sent Events stream. Events: update (status change), reload (config change), screenshots_done.",
      },
      {
        method: "GET",
        path: "/api/log/:id",
        desc: "Last 30 lines of app log",
        body: "Returns { lines: [...] } from the app's log file.",
        tryUrl: "/api/log/bheng",
        tryLabel: "Try (bheng)",
      },
      {
        method: "POST",
        path: "/api/start/:id",
        desc: "Start app via LaunchAgent",
        body: "Loads and starts the app's LaunchAgent plist.",
      },
    ],
  },
  {
    title: "Machine Sync",
    endpoints: [
      {
        method: "GET",
        path: "/api/machine",
        desc: "Machine identity",
        body: "Returns hostname, model, LAN IP, port, and app count.",
        tryUrl: "/api/machine",
      },
      {
        method: "GET",
        path: "/api/apps/export",
        desc: "Portable app list for syncing",
        body: "Returns app list without machine-specific paths. Used by /api/sync.",
        tryUrl: "/api/apps/export",
      },
      {
        method: "POST",
        path: "/api/sync",
        desc: "Pull apps from another machine",
        body: "Connects to a remote Local Apps instance and merges its app list. Adds missing apps, syncs ports/repos/icons.",
        params: [
          { name: "remote", type: "string", required: true, desc: 'IP or IP:port of remote machine (e.g. "10.0.0.218")' },
        ],
        example: `curl -X POST http://localhost:9876/api/sync \\
  -H "Content-Type: application/json" \\
  -d '{"remote":"10.0.0.218"}'`,
      },
    ],
  },
  {
    title: "Screenshots",
    endpoints: [
      {
        method: "GET",
        path: "/api/screenshots/:id",
        desc: "Get screenshots for an app",
        body: "Returns screenshot list and capture timestamp.",
        tryUrl: "/api/screenshots/bheng",
        tryLabel: "Try (bheng)",
      },
      {
        method: "POST",
        path: "/api/screenshots/:id",
        desc: "Capture screenshots for an app",
        body: "Triggers the screenshot bot for the specified app. Runs in background.",
        example: `curl -X POST http://localhost:9876/api/screenshots/bheng`,
      },
      {
        method: "GET",
        path: "/api/screenshots-status",
        desc: "Running screenshot jobs",
        body: "Returns currently running screenshot capture jobs.",
        tryUrl: "/api/screenshots-status",
      },
      {
        method: "DELETE",
        path: "/api/screenshot",
        desc: "Delete a screenshot",
        params: [
          { name: "appId", type: "string", required: true, desc: "App ID" },
          { name: "mode", type: "string", required: true, desc: '"desktop" or "mobile"' },
          { name: "filename", type: "string", required: true, desc: "Screenshot filename" },
        ],
      },
    ],
  },
  {
    title: "Other",
    endpoints: [
      {
        method: "GET",
        path: "/api/qr",
        desc: "QR code for LAN access",
        body: "Returns { url, dataUrl } -- a QR code image (base64) pointing to the LAN dashboard URL.",
        tryUrl: "/api/qr",
      },
    ],
  },
];

/* ── copy helper ── */
function copyText(text: string, setCopied: (v: string | null) => void, id: string) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  });
}

/* ── CodeBlock with copy ── */
function CodeBlock({ code, id, copiedId, setCopied }: { code: string; id: string; copiedId: string | null; setCopied: (v: string | null) => void }) {
  return (
    <pre style={styles.pre}>
      {code}
      <button style={styles.copyBtn} onClick={() => copyText(code, setCopied, id)}>
        {copiedId === id ? "Copied!" : "Copy"}
      </button>
    </pre>
  );
}

/* ── Params table ── */
function ParamsTable({ params }: { params: Param[] }) {
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Field</th>
          <th style={styles.th}>Type</th>
          <th style={styles.th}></th>
          <th style={styles.th}>Description</th>
        </tr>
      </thead>
      <tbody>
        {params.map((p) => (
          <tr key={p.name}>
            <td style={styles.td}>{p.name}</td>
            <td style={styles.td}>{p.type}</td>
            <td style={styles.td}>
              <span style={{ color: p.required ? "#f87171" : "#555", fontSize: 9 }}>
                {p.required ? "required" : "optional"}
              </span>
            </td>
            <td style={styles.td}>{p.desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── Try-it button + result ── */
function TryIt({ url, label, copiedId, setCopied }: { url: string; label?: string; copiedId: string | null; setCopied: (v: string | null) => void }) {
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(url);
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2).slice(0, 3000));
    } catch (e: unknown) {
      setResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [url]);

  const resultId = `try-${url}`;

  return (
    <div>
      <button style={styles.tryBtn} onClick={run}>
        {label || "Send"}
      </button>
      {loading && (
        <pre style={{ ...styles.pre, color: "#555", marginTop: 8 }}>Loading...</pre>
      )}
      {result && (
        <pre style={{ ...styles.pre, marginTop: 8, color: result.startsWith("Error:") ? "#f87171" : "#a5b4fc" }}>
          {result}
          {!result.startsWith("Error:") && (
            <button style={styles.copyBtn} onClick={() => copyText(result, setCopied, resultId)}>
              {copiedId === resultId ? "Copied!" : "Copy"}
            </button>
          )}
        </pre>
      )}
    </div>
  );
}

/* ── Single endpoint row ── */
function EndpointCard({ ep, copiedId, setCopied }: { ep: Endpoint; copiedId: string | null; setCopied: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const mc = METHOD_COLORS[ep.method] || METHOD_COLORS.GET;

  return (
    <div style={styles.endpoint}>
      <div style={styles.epHeader} onClick={() => setOpen(!open)}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: 4,
            letterSpacing: "0.05em",
            minWidth: 52,
            textAlign: "center" as const,
            flexShrink: 0,
            background: mc.bg,
            color: mc.color,
          }}
        >
          {ep.method}
        </span>
        <span style={{ fontSize: 13, color: "#fff", fontWeight: 600 }}>{ep.path}</span>
        <span style={{ color: "#555", fontSize: 11, marginLeft: "auto" }}>{ep.desc}</span>
      </div>
      {open && (
        <div style={styles.epBody}>
          {ep.body && <p style={{ fontSize: 11, color: "#555", margin: "12px 0 8px" }}>{ep.body}</p>}
          {ep.params && (
            <>
              <div style={styles.label}>Body</div>
              <ParamsTable params={ep.params} />
            </>
          )}
          {ep.example && (
            <>
              <div style={styles.label}>Example</div>
              <CodeBlock code={ep.example} id={`ex-${ep.path}-${ep.method}`} copiedId={copiedId} setCopied={setCopied} />
            </>
          )}
          {ep.tryUrl && (
            <>
              <div style={styles.label}>Try it</div>
              <TryIt url={ep.tryUrl} label={ep.tryLabel} copiedId={copiedId} setCopied={setCopied} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Page ── */
export default function DocsPage() {
  const [copiedId, setCopied] = useState<string | null>(null);

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "24px" }}>
      <header style={{ padding: "20px 0", borderBottom: "1px solid var(--border)", marginBottom: 28, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>API Docs</h1>
      </header>

      {CATEGORIES.map((cat) => (
        <div key={cat.title}>
          <h2 style={styles.h2}>{cat.title}</h2>
          {cat.endpoints.map((ep) => (
            <EndpointCard key={`${ep.method}-${ep.path}`} ep={ep} copiedId={copiedId} setCopied={setCopied} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── styles ── */
const styles: Record<string, React.CSSProperties> = {
  h2: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#555",
    fontWeight: 600,
    margin: "32px 0 12px",
  },
  endpoint: {
    background: "#161616",
    border: "1px solid #222",
    borderRadius: 8,
    marginBottom: 10,
    overflow: "hidden",
  },
  epHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 16px",
    cursor: "pointer",
    transition: "background 0.1s",
  },
  epBody: {
    padding: "0 16px 16px",
    borderTop: "1px solid #222",
  },
  label: {
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#555",
    fontWeight: 600,
    margin: "14px 0 6px",
  },
  pre: {
    background: "rgba(0,0,0,0.4)",
    border: "1px solid #222",
    borderRadius: 6,
    padding: "10px 14px",
    fontSize: 11,
    color: "#a5b4fc",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    position: "relative",
  },
  copyBtn: {
    position: "absolute",
    top: 6,
    right: 8,
    background: "rgba(255,255,255,0.08)",
    border: "1px solid #222",
    color: "#555",
    fontFamily: "inherit",
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: 4,
    cursor: "pointer",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 11,
    margin: "6px 0",
  },
  th: {
    textAlign: "left",
    color: "#555",
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    padding: "4px 8px",
    borderBottom: "1px solid #222",
  },
  td: {
    padding: "6px 8px",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  tryBtn: {
    background: "rgba(165,180,252,0.12)",
    border: "1px solid rgba(165,180,252,0.3)",
    color: "#a5b4fc",
    fontFamily: "inherit",
    fontSize: 10,
    padding: "4px 12px",
    borderRadius: 4,
    cursor: "pointer",
    marginTop: 8,
  },
};
