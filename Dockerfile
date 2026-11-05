# Dockerfile for the Nexum Host (`nexum serve`) — see deploy/local/docker-compose.yml
# for the full local stack (Postgres + Redis + Nexum + Agentic Chat).
#
# Usage:
#   docker build -t nexum .
#   docker run -p 3777:3777 -e DATABASE_URL=... -e REDIS_URL=... nexum
#
# Note: this image does not run `playwright install` — the browser tool
# (src/browser/manager.ts) will not work inside this container without
# additional setup. Not needed for the Session/Run/Event API this image
# exists to serve; revisit if/when browser automation moves behind it too.

# ── Build stage ─────────────────────────────────────────────────────────
FROM node:22-slim AS builder

# better-sqlite3 (native module) needs a toolchain to build from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ── Runtime stage ───────────────────────────────────────────────────────
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
    CMD node -e "fetch('http://localhost:3777/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3777

# Absolute path: docker-compose.yml overrides `command` (to add
# --workspace once a volume is mounted) without overriding `working_dir`,
# so a relative `bin/cli.js` would resolve against whatever directory the
# container starts in, not /app.
ENTRYPOINT ["node", "/app/bin/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3777"]
