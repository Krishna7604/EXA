# exa server image. Build: docker build -t exa-server .
FROM oven/bun:1.4-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/router/package.json packages/router/
COPY packages/tools/package.json packages/tools/
COPY packages/store/package.json packages/store/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4-debian
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages packages
COPY --from=deps /app/apps apps
COPY packages packages
COPY apps apps
COPY package.json tsconfig.json ./
ENV NODE_ENV=production EXA_HOST=0.0.0.0 PORT=4317 EXA_DATA_DIR=/data
# The server runs as `bun`, so it must own its data dir (a new named volume copies this ownership).
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 4317
USER bun
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:4317/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "--no-env-file", "run", "apps/server/src/main.ts"]
