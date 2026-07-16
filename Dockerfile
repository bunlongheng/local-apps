# Runs the Local Apps dashboard + control API in a container.
# Note: launchd/Caddy provisioning is macOS-host-only, so a container runs in
# "agent" (monitoring / status-reporting) mode by default - point it at a hub or
# use it to view the dashboard. Set MACHINE_ROLE=hub only on a macOS host.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV MACHINE_ROLE=agent
# Copy the built app, then reinstall only production deps (drops playwright,
# eslint, typescript, resvg from the runtime image; native better-sqlite3/sharp
# are rebuilt for this stage).
COPY --from=build /app/package*.json ./
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/app ./app
COPY --from=build /app/components ./components
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/server.js /app/db.js /app/launchctl-cmds.js /app/launchd-parse.js /app/next.config.ts /app/tsconfig.json ./
RUN npm ci --omit=dev
EXPOSE 9876 9875
# Probe the control API through the Next proxy so a dead server.js fails the check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:9876/api/status',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
# API on 9875 (localhost), dashboard on 9876 (exposed).
CMD ["sh", "-c", "API_BIND=127.0.0.1 node server.js & exec npx next start -p 9876 --hostname 0.0.0.0"]
