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
# The image-drift fingerprint covers only what app-bundle self-updates cannot
# deliver: the dependency tree baked into node_modules and this Dockerfile
# (base image, apt ffmpeg). App sources are deliberately excluded - bundles
# keep the running code lockstep with the server, so hashing sources would
# re-flag every self-built image on every deploy.
RUN bridge_source_fingerprint="$PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT" \
  && if [ "$bridge_source_fingerprint" = "unknown" ]; then \
    bridge_source_fingerprint="$(find package-lock.json apps/bridge/Dockerfile -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"; \
  fi \
  && printf '{"bridgeBuildRevision":"%s","bridgeSourceFingerprint":"%s"}\n' "$PRINTSTREAM_BRIDGE_BUILD_REVISION" "$bridge_source_fingerprint" > bridge-build-metadata.json
RUN npm run db:generate
RUN npm run build --workspace @printstream/shared \
  && npm run build --workspace @printstream/bridge-runtime \
  && npm run build --workspace @printstream/api

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
# /run/provision holds the managed-bridge provisioning token. Owning the
# mountpoint as `node` means a fresh named volume mounted here inherits that
# ownership, so the unprivileged API process can write the token file.
RUN mkdir -p /data /run/provision && chown -R node:node /data /run/provision
COPY --chown=node:node --from=build /app /app
USER node
EXPOSE 4000
CMD ["sh", "-c", "node scripts/bootstrap-prisma-migrations.mjs && node apps/api/dist/index.js"]
