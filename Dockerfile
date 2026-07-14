# Runs the Local Apps dashboard + control API in a container.
# Note: launchd/Caddy provisioning is macOS-host-only, so a container runs in
# "agent" (monitoring / status-reporting) mode by default - point it at a hub or
# use it to view the dashboard. Set MACHINE_ROLE=hub only on a macOS host.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV MACHINE_ROLE=agent
COPY --from=build /app ./
EXPOSE 9876 9875
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:9876/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
# API on 9875 (localhost), dashboard on 9876 (exposed).
CMD ["sh", "-c", "API_BIND=127.0.0.1 node server.js & exec npx next start -p 9876 --hostname 0.0.0.0"]
