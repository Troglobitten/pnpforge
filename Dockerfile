# syntax=docker/dockerfile:1

# ---------- build the web client ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build

# ---------- runtime ----------
FROM node:22-slim
LABEL org.opencontainers.image.title="pnpforge" \
      org.opencontainers.image.description="Self-hosted workshop and virtual tabletop for solo print-and-play games" \
      org.opencontainers.image.source="https://github.com/Troglobitten/pnpforge" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    PNPFORGE_PORT=3717 \
    PNPFORGE_HOST=0.0.0.0 \
    PNPFORGE_DATA=/data

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/shared ./src/shared

# the data volume belongs to the unprivileged user the server runs as
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3717

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PNPFORGE_PORT||3717)+'/api/games').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server/index.ts"]
