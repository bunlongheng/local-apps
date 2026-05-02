import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const host = req.headers.get("host") || "localhost:9876";
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const startUrl = `${proto}://${host}/`;

  let label = "Local Apps";
  if (host.startsWith("100.")) label = "Apps (Tailscale)";
  else if (host.startsWith("10.") || host.startsWith("192.168.")) label = "Apps (LAN)";
  else if (host.endsWith(".localhost")) label = "Apps (Caddy)";

  const manifest = {
    name: label,
    short_name: label,
    start_url: startUrl,
    display: "standalone",
    background_color: "#0d0d0d",
    theme_color: "#0d0d0d",
    icons: [
      { src: "/favicons/local-apps.png", sizes: "256x256", type: "image/png" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };

  return NextResponse.json(manifest, {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
