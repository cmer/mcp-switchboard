# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
# pnpm at the version pinned by `packageManager` in package.json.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# npx/uvx for stdio MCP servers that are fetched on demand (uvx needs python;
# git + ca-certificates are needed for `git+https://…` package specs). uv goes on the
# system PATH, not root's home, so the sandboxed servers (and the `node` user) can run it.
# bubblewrap is the sandbox every stdio server runs in (see docs/sandbox.md).
RUN apt-get update && apt-get install -y --no-install-recommends python3 pipx git ca-certificates bubblewrap \
  && rm -rf /var/lib/apt/lists/* \
  && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install uv
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
# pnpm's store and metadata cache sit in a build cache, and corepack's copy of pnpm is removed,
# so only node_modules ends up in the image.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  --mount=type=cache,target=/root/.cache/pnpm \
  corepack enable \
  && pnpm install --frozen-lockfile --prod --filter ./server \
  && rm -rf /root/.cache/node /tmp/node-compile-cache
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

COPY docker/entrypoint.sh /usr/local/bin/switchboard-entrypoint

ENV PORT=8787
ENV DATA_DIR=/app/data
ENV SANDBOX_DIR=/app/sandboxes
ENV WEB_DIST=/app/web/dist
VOLUME /app/data
EXPOSE 8787
WORKDIR /app/server
# Starts as root to hand volumes from older images over, then runs as `node`.
ENTRYPOINT ["switchboard-entrypoint"]
CMD ["node", "dist/index.js"]
