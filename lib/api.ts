export async function fetchJSON<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path);
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
  tabColor: string | null;
  tabIcon: string | null;
}
