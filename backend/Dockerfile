# Minimal backend Dockerfile. Frontend builds (client + admin) are done
# manually before `docker build`, and copied into backend/public/ —
# the container just ships them as static files alongside the API.
#
# Build context = this folder (backend/).
#
#   cd backend
#   docker build -t trading-platform .
#   docker run -d -p 80:5000 --env-file .env --name tp trading-platform

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

# Install only prod deps. `npm ci` falls back to `npm install` if the
# lock file is out of sync (e.g. after adding razorpay locally).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund

# Backend source
COPY src ./src

# Pre-built frontends. Run before building the image:
#   cd ../client && npm run build && cd ..
#   cd ../admin  && npm run build && cd ..
#   xcopy /E /I /Y ..\client\dist backend\public\client
#   xcopy /E /I /Y ..\admin\dist  backend\public\admin
COPY public ./public

EXPOSE 5000
CMD ["node", "src/server.js"]
