FROM node:24.19.0-bookworm-slim AS build
ENV CI=true
ARG DEBIAN_MIRROR=http://deb.debian.org
ARG COREPACK_NPM_REGISTRY=https://registry.npmjs.org
# corepack 只认 COREPACK_NPM_REGISTRY；pnpm 11 忽略 npm_config_registry，只读 .npmrc。
# 不共用这个开关时，pnpm install 会走官方源。中国大陆构建可通过 .env 或 --build-arg
# 切换到 USTC / npmmirror，见 compose.build.yaml。
ENV COREPACK_NPM_REGISTRY=${COREPACK_NPM_REGISTRY} npm_config_registry=${COREPACK_NPM_REGISTRY}
RUN printf 'registry=%s\n' "$COREPACK_NPM_REGISTRY" > "$HOME/.npmrc"
WORKDIR /build
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY docker ./docker
RUN pnpm typecheck && pnpm build && pnpm prune --prod

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production TESSERA_DB=/data/tessera.db TESSERA_CONFIG=/data/runtime.json TESSERA_PORT=8000
WORKDIR /opt/tessera
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json LICENSE ./
EXPOSE 8000
CMD ["node", "dist/server.mjs"]
