# =============================================================================
# Combined Dockerfile — backend + frontends in one container.
#
#   Stage 1 (client-build) : `vite build` the user-facing SPA → dist/
#   Stage 2 (admin-build)  : `vite build` the admin SPA with /admin/ base
#   Stage 3 (backend-deps) : `npm ci --omit=dev` for backend
#   Stage 4 (runtime)      : slim alpine, non-root, stitched together
#
# Build context MUST be the repo root so we can reach client/ and admin/.
# This Dockerfile lives in backend/ but is built with `-f`:
#
#   # from repo root:
#   docker build -f backend/Dockerfile -t trading-platform .
#   docker run -d --restart unless-stopped \
#     -p 80:5000 --env-file backend/.env --name tp trading-platform
#
# Or via the compose file next to this Dockerfile:
#   cd backend && docker compose up -d --build
#
# Final layout inside the image:
#   /app/src/                   ← backend source
#   /app/node_modules/          ← prod deps
#   /app/public/client/         ← client SPA (served at /)
#   /app/public/admin/          ← admin SPA  (served at /admin)
#
# Image runs as `node` (uid 1000). Default port 5000.
# =============================================================================

# ─── Stage 1: client SPA ────────────────────────────────────────────────────
FROM node:20-alpine AS client-build
WORKDIR /app/client

COPY client/package.json client/package-lock.json* ./
RUN npm ci || npm install --no-audit --no-fund

COPY client/ ./
# Frontend hits same-origin /api — VITE_API_URL bakes that into the bundle.
ENV VITE_API_URL=/api
RUN npm run build


# ─── Stage 2: admin SPA (served at /admin/*) ────────────────────────────────
FROM node:20-alpine AS admin-build
WORKDIR /app/admin

COPY admin/package.json admin/package-lock.json* ./
RUN npm ci || npm install --no-audit --no-fund

COPY admin/ ./
# VITE_BASE makes Vite emit assets with /admin/ prefix; basename in
# main.jsx (BrowserRouter) reads import.meta.env.BASE_URL automatically.
ENV VITE_BASE=/admin/
ENV VITE_API_URL=/api
RUN npm run build


# ─── Stage 3: backend node_modules (cacheable) ──────────────────────────────
FROM node:20-alpine AS backend-deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
# Prefer reproducible `npm ci` (strict lock-file match). Fall back to
# `npm install` only when the lock file is out of sync with package.json
# — local dev sometimes can't `npm install` due to network/SSL quirks,
# but Docker can. The fallback keeps the build moving instead of failing.
RUN npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund


# ─── Stage 4: slim runtime ──────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

# node:20-alpine ships with `node` user uid 1000. Running as non-root is a
# basic hardening step in case a container escape ever lands.
USER node

# Backend code + deps
COPY --chown=node:node --from=backend-deps /app/node_modules ./node_modules
COPY --chown=node:node backend/src ./src
COPY --chown=node:node backend/package.json ./

# Stitch frontends into backend/public.
# Server.js mounts:
#   public/client/index.html → /
#   public/admin/index.html  → /admin
COPY --chown=node:node --from=client-build /app/client/dist ./public/client
COPY --chown=node:node --from=admin-build  /app/admin/dist  ./public/admin

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/ready >/dev/null || exit 1

CMD ["node", "src/server.js"]
