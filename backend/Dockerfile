# Multi-stage build for the Node.js backend.
# Stage 1: install deps (cacheable layer).
# Stage 2: slim runtime, non-root, with /api/ready as the probe.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as non-root. node:20-alpine ships with `node` user uid 1000.
USER node

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node src ./src
COPY --chown=node:node package.json ./

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/ready || exit 1

CMD ["node", "src/server.js"]
