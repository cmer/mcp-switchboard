# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# npx/uvx for stdio MCP servers that are fetched on demand (uvx needs python)
RUN apt-get update && apt-get install -y --no-install-recommends python3 pipx && rm -rf /var/lib/apt/lists/* \
  && pipx install uv || true
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

ENV PORT=8787
ENV DATA_DIR=/app/data
ENV WEB_DIST=/app/web/dist
VOLUME /app/data
EXPOSE 8787
WORKDIR /app/server
CMD ["node", "dist/index.js"]
