import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:9875/api/:path*",
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
        ],
      },
    ];
  },
};

export default nextConfig;
