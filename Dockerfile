# Runs the Local Apps dashboard + control API in a container - a single Node
# process (Express) that serves the static UI (public/) AND the control API on :9875.
# No build step, no Next.js.
# Note: launchd/Caddy provisioning is macOS-host-only, so a container runs in
# "agent" (monitoring / status-reporting) mode by default - point it at a hub or
# use it to view the dashboard. Set MACHINE_ROLE=hub only on a macOS host.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV MACHINE_ROLE=agent
ENV API_BIND=0.0.0.0
COPY package*.json ./
# Production deps only (drops playwright, eslint, typescript, resvg); native
# better-sqlite3/sharp are built for this image.
RUN npm ci --omit=dev
COPY server.js db.js launchctl-cmds.js launchd-parse.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
EXPOSE 9875
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:9875/api/status',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
