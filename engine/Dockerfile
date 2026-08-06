# Bulls ⚔ Unicorns engine — custodial launch image. Host-agnostic (Fly / Railway / VPS).
# Node 24 is required: the ledger uses the built-in node:sqlite (stable from 22.5) and node:test.
# Build context = the REPO ROOT (not engine/), because the image also ships the player-facing
# web/ files — the engine serves them so the game is one URL with no separate frontend host.
#   fly deploy . --config engine/fly.toml --dockerfile engine/Dockerfile
FROM node:24-slim

WORKDIR /app

# Install deps first so the layer caches across code changes. tsx + @solana are runtime deps,
# so --omit=dev keeps them; there are no devDependencies to drop.
COPY engine/package.json engine/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY engine/ ./
COPY web/ ./web/

# The SQLite ledger MUST live on a persistent volume — mount one at /data on the host.
ENV LEDGER_DIR=/data
ENV PORT=8090
ENV WEB_DIR=/app/web
VOLUME ["/data"]
EXPOSE 8090

# Liveness only — /live, NOT /health. /health returns 503 on a solvency freeze, which a restart
# cannot fix; using it here would restart-loop the engine during a money incident.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Secrets (vault key) come from VAULT_SECRET_KEY at runtime — NEVER baked into the image.
CMD ["npx", "tsx", "src/server.ts"]
