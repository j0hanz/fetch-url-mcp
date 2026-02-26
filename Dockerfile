FROM node:24-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/ ./scripts/
COPY assets/ ./assets/
COPY src/ ./src/
RUN npm run build
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
FROM node:24-alpine
ARG VERSION
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="Fetch URL MCP Server" \
      org.opencontainers.image.description="Intelligent web content fetcher MCP server that converts HTML to clean, AI-readable Markdown" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/j0hanz/fetch-url-mcp" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.j0hanz/fetch-url-mcp"
RUN adduser -D mcp
WORKDIR /app
COPY --from=builder --chown=mcp:mcp /app/dist ./dist/
COPY --from=prod-deps --chown=mcp:mcp /app/node_modules ./node_modules/
COPY --from=builder --chown=mcp:mcp /app/package.json ./
COPY --from=builder --chown=mcp:mcp /app/assets ./assets/
USER mcp
ENTRYPOINT ["node", "dist/index.js"]
