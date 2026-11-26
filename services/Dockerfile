# SplitStock services: keeper, agent and API share one image; the compose command picks the role.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DEPLOYMENTS_DIR=/app/deployments
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY db ./db
USER node
# deployments/ is mounted read-only from the repo root at runtime (the only address book)
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli.js"]
CMD ["api"]
