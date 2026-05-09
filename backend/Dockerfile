FROM node:20-alpine

WORKDIR /app

# Install deps separately for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 5000

CMD ["node", "src/server.js"]
