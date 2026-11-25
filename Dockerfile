# Multi-tenant receptionist API (server/platform/main.ts). The web demo is static (Vite) and
# deploys separately (vercel.json). No secrets in the image: pass DATABASE_URL, AUTH_SECRET, LLM_API_KEY at runtime.
# Local stack with Postgres: docker compose up --build (docker-compose.yml). Admin: docker compose exec api npm run db:user -- ...
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production PORT=8787 LOG_LEVEL=info
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig*.json ./
COPY server ./server
COPY src ./src
COPY config ./config
COPY scripts/db.mts ./scripts/db.mts
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "server/platform/main.ts"]
