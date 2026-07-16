import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:9875/api/:path*",
      },
      // Proxy app favicons to the Express server, which serves them live from
      // public/favicons. `next start` otherwise snapshots public/ at build time,
      // so a favicon added after the last build 404s until a rebuild - this makes
      // newly-synced app icons show immediately with no rebuild.
      {
        source: "/favicons/:path*",
        destination: "http://localhost:9875/favicons/:path*",
      },
    ];
  },
  // Baseline security headers. HSTS is intentionally omitted: this dashboard is
  // served over plain http on the LAN/tailnet, and forcing HTTPS would break access.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Second layer behind the README sanitizer. 'unsafe-inline' is kept because the
          // dashboard is inline-style + Next-inline-script heavy (a nonce refactor is a
          // separate task), but external script/object sources and framing are blocked.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
