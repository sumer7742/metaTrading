# Same shape as client/Dockerfile but serves the admin SPA.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
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
  location ~* \.(js|css|svg|woff2?|png|jpg|ico)\$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
EOF
EXPOSE 80
