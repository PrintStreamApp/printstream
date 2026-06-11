# API image. Mirrors game-is-up's apps/api/Dockerfile layout: a single
# `node:22-bookworm-slim` base used for both build and runtime, with
# Prisma generated against the API schema at build time. Runs as the
# unprivileged `node` user. PostgreSQL lives in the compose `db`
# service; `/data` stores library files, plugin storage, and other
# API-owned assets.
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
ARG PRINTSTREAM_BRIDGE_BUILD_REVISION=unknown
ARG PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT=unknown
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/bridge-runtime/package.json packages/bridge-runtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
RUN npm ci
COPY . .
RUN bridge_source_fingerprint="$PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT" \
  && if [ "$bridge_source_fingerprint" = "unknown" ]; then \
    bridge_source_fingerprint="$(find apps/bridge/src packages/bridge-runtime/src packages/shared/src apps/bridge/package.json packages/bridge-runtime/package.json packages/shared/package.json apps/bridge/Dockerfile apps/bridge/tsconfig.json packages/bridge-runtime/tsconfig.json packages/shared/tsconfig.json tsconfig.base.json package-lock.json -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"; \
  fi \
  && printf '{"bridgeBuildRevision":"%s","bridgeSourceFingerprint":"%s"}\n' "$PRINTSTREAM_BRIDGE_BUILD_REVISION" "$bridge_source_fingerprint" > bridge-build-metadata.json
RUN npm run db:generate
RUN npm run build --workspace @printstream/shared \
  && npm run build --workspace @printstream/bridge-runtime \
  && npm run build --workspace @printstream/api

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /data && chown -R node:node /data
COPY --chown=node:node --from=build /app /app
USER node
EXPOSE 4000
CMD ["sh", "-c", "node scripts/bootstrap-prisma-migrations.mjs && node apps/api/dist/index.js"]
