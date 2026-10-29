# ─────────────────────────────────────────────────────────────
#  Public Health Colosseum — container image
#  Built and run by ./ctl.sh. See docs/DEPLOY-VPS.md.
# ─────────────────────────────────────────────────────────────

# ── build: compile TypeScript ────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# Install scripts are skipped: every runtime dependency is pure JavaScript,
# and this matches how the platform has always been installed and tested.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime: production dependencies only ────────────────────
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public
COPY views ./views
COPY drizzle ./drizzle

# The WhatsApp session. Mounted from the host so it survives rebuilds — losing
# it means pairing again. World-writable so the container user (chosen at run
# time by ctl.sh, to suit rootful or rootless Docker) can always write it.
RUN mkdir -p /app/auth && chmod 0777 /app/auth
VOLUME ["/app/auth"]

EXPOSE 3100

# Checks that the app is serving, not that WhatsApp is paired: /health
# returns 503 until a QR is scanned, which would mark a perfectly healthy
# container "unhealthy" while it waits. /api/status answers 200 either way.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
