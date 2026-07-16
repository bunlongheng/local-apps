import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    name: "Local Apps Monitor API",
    version: "1.0",
    base: "http://localhost:9876",
    note: "All /api/* routes proxy to the Express backend on :9875. This endpoint documents how to register and manage apps.",

    endpoints: {
      "POST /api/apps": {
        description: "Register a new app with the monitor",
        required: {
          id: "App slug (lowercase, kebab-case, 1-64 chars). Example: 'my-app'",
          name: "Display name. Example: 'My App'",
          localPath: "Absolute path to project root. Example: '/Users/me/Sites/my-app'",
        },
        infrastructure: {
          localUrl: "Defaults to next available port (auto-assigned)",
          healthUrl: "Defaults to localUrl",
          repo: "GitHub URL. Example: 'https://github.com/me/my-app'",
          startCommand: "Defaults to 'npm run dev'",
          logPath: "Defaults to /tmp/{id}.log",
          prodUrl: "Production URL. Example: 'https://my-app.vercel.app'",
          noScreenshot: "Skip screenshots (boolean, default false)",
          icon: "URL or path to app icon",
        },
        profile: {
          about: "One compelling sentence describing the app",
          features: "JSON array of 3-5 top features",
          architect: "Paragraph on tech stack and architecture",
          deploy: "Paragraph on how to deploy and run",
          security: "JSON array of 3-4 security measures",
          performance: "JSON array of 3-4 performance optimizations",
          prompt: "Gemini image gen prompt for the app icon. Format: 'Design a 1024x1024 app icon for [name]. [2-3 sentences describing visual]. Dark background with rounded iOS corners. No text, no watermark.'",
        },
        auto: [
          "Assigns a dedicated port if not provided",
          "Creates a Caddy reverse proxy at http://{id}.localhost",
          "Creates a macOS LaunchAgent plist for auto-start",
          "Begins health-checking every 10s",
          "Shows app on all dashboard pages with full profile",
        ],
        example: {
          id: "my-app",
          name: "My App",
          localPath: "/Users/me/Sites/my-app",
          repo: "https://github.com/me/my-app",
          startCommand: "npm run dev",
          prodUrl: "https://my-app.vercel.app",
          about: "A powerful tool that does amazing things.",
          features: ["Feature one", "Feature two", "Feature three"],
          architect: "Built with Next.js 16, React 19, TypeScript, and Tailwind. Uses SQLite for persistence.",
          deploy: "Run npm install && npm run dev. Deployed to Vercel on push to main.",
          security: ["Security headers on all responses", "Auth required for admin routes"],
          performance: ["Server components by default", "Lazy-loaded heavy dependencies"],
          prompt: "Design a 1024x1024 app icon for My App. A glowing cube with circuit lines. Blue palette on dark background. Rounded iOS corners. No text, no watermark.",
        },
      },

      "GET /api/apps": {
        description: "List all registered apps",
      },

      "GET /api/apps/:id": {
        description: "Get a single app by ID",
      },

      "PUT /api/apps/:id": {
        description: "Update an existing app (partial update supported)",
      },

      "DELETE /api/apps/:id": {
        description: "Delete an app and tear down its infrastructure (Caddy, LaunchAgent, screenshots, process)",
      },

      "GET /api/status": {
        description: "Get all apps with live health status, LAN IP, Tailscale IP, and machine model",
      },

      "POST /api/start/:id": {
        description: "Start a stopped app via its LaunchAgent",
      },

      "GET /api/screenshots/:id": {
        description: "Get screenshot list for an app",
      },

      "POST /api/screenshots/:id": {
        description: "Capture new screenshots for an app",
      },

      "POST /api/generate-icons/:id": {
        description: "Generate an AI app icon using the app's prompt field",
      },

      "GET /api/crons": {
        description: "List all cron/routine jobs and their status",
      },

      "POST /api/crons/:id/toggle": {
        description: "Enable or disable a cron job",
      },

      "GET /api/machines": {
        description: "List registered remote machines",
      },

      "GET /api/machines/:id/status": {
        description: "Get app status from a remote machine",
      },

      "GET /api/qr": {
        description: "Get LAN QR code as data URL",
      },

      "GET /api/events": {
        description: "SSE stream for real-time status updates",
      },
    },
  });
}
