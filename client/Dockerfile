# Multi-stage build for the React client (Vite).
#   Stage 1: install + build → produces /app/dist
#   Stage 2: nginx serves the static bundle.
#
# At runtime nginx falls back to index.html for unknown paths so client-side
# routing works on deep-links (/trade, /wallet, etc.).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
# Vite reads VITE_* envs at build time. Pass production values via
# --build-arg or `docker build --build-arg VITE_API_BASE=...`.
ARG VITE_API_BASE
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY <<EOF /etc/nginx/conf.d/default.conf
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  location / {
    try_files \$uri \$uri/ /index.html;
  }
  # Cache assets aggressively, never cache the entry HTML.
  location ~* \.(js|css|svg|woff2?|png|jpg|ico)\$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
EOF
EXPOSE 80
