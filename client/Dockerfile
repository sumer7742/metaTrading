# Client SPA — multi-stage:
#   1. node:20-alpine    : vite build with VITE_API_URL baked in
#   2. nginx:1.27-alpine : serves dist/ on port 80 with SPA routing fix
#
# Build context = client/
#   cd client
#   docker build --build-arg VITE_API_URL=https://api.zerovant.in/api -t tp-client .

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install --no-audit --no-fund

COPY . .

# Baked into the bundle at build time. Override with `--build-arg` for
# different environments (staging vs prod). Default points at the prod
# subdomain so a no-arg build still produces a correct artifact.
ARG VITE_API_URL=https://api.zerovant.in/api
ENV VITE_API_URL=$VITE_API_URL
ARG VITE_WS_URL=wss://api.zerovant.in/ws
ENV VITE_WS_URL=$VITE_WS_URL

RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
