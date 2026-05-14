# Admin SPA — multi-stage, same shape as client/Dockerfile.
#
# Build context = admin/
#   cd admin
#   docker build --build-arg VITE_API_URL=https://trading.metawebdevelopment.cloud/api \
#                --build-arg VITE_BASE=/admin/ -t tp-admin .

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install --no-audit --no-fund

COPY . .

# Admin is served under /admin/ on the unified domain
# (trading.metawebdevelopment.cloud/admin/). VITE_BASE drives the prefix
# emitted in index.html asset URLs so they resolve correctly under /admin/.
ARG VITE_BASE=/admin/
ENV VITE_BASE=$VITE_BASE
ARG VITE_API_URL=https://trading.metawebdevelopment.cloud/api
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
