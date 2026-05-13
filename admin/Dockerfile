# Admin SPA — multi-stage, same shape as client/Dockerfile.
#
# Build context = admin/
#   cd admin
#   docker build --build-arg VITE_API_URL=https://api.zerovant.in/api -t tp-admin .

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install --no-audit --no-fund

COPY . .

# Admin sits on its own subdomain (admin.zerovant.in) — base path is /.
# We override VITE_BASE here so the env-driven vite.config produces a
# root-relative bundle, NOT a /admin/ prefixed one.
ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE
ARG VITE_API_URL=https://api.zerovant.in/api
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
