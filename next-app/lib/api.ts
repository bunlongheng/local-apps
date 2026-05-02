const BASE = "";

export async function fetchJSON<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

export interface AppStatus {
  id: string;
  name: string;
  status: "up" | "down" | "unknown";
  healthUrl: string | null;
  localUrl: string | null;
  caddyUrl: string | null;
  prodUrl: string | null;
  repo: string | null;
  icon: string | null;
  noScreenshot: boolean;
  lastChecked: string | null;
  hasScreenshots: boolean;
}

export interface StatusResponse {
  apps: AppStatus[];
  lanIp: string;
  tailscaleIp: string | null;
  machineModel: string;
}

export interface NavCounts {
  apps: number;
  crons: number;
  screenshots: number;
  readmes: number;
}

export function getStatus(): Promise<StatusResponse> {
  return fetchJSON("/api/status");
}

export function getApps(): Promise<AppStatus[]> {
  return fetchJSON("/api/apps");
}

export async function getNavCounts(): Promise<NavCounts> {
  const [status, crons, screenshots] = await Promise.all([
    fetchJSON<StatusResponse>("/api/status").catch(() => ({ apps: [] })),
    fetchJSON<{ crons: unknown[] }>("/api/crons").catch(() => ({ crons: [] })),
    fetchJSON<{ screenshots: Record<string, unknown> }>("/api/screenshots").catch(() => ({ screenshots: {} })),
  ]);
  return {
    apps: "apps" in status ? status.apps.length : 0,
    crons: "crons" in crons ? crons.crons.length : 0,
    screenshots: "screenshots" in screenshots ? Object.keys(screenshots.screenshots).length : 0,
    readmes: 0,
  };
}
