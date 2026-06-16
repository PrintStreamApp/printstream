# Combined PrintStream app image. Builds the web SPA, the API, and the bridge in
# one image; the entrypoint (docker/app-entrypoint.sh) runs whichever role you
# point it at — `api` (default; serves web + /api + /ws on one port) or `bridge`.
# Using one image for the whole app keeps the cloud build and the published
# open-core image identical (no divergence). Runs as the unprivileged `node`
# user. PostgreSQL lives in the compose `db` service; `/data` stores library
# files, plugin storage, and other API-owned assets.
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
ARG BRIDGE_BUILD_REVISION=unknown
ARG PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT=unknown
# App image identity, surfaced in the web footer. REVISION is the git commit the
# image was built from; PUBLISHED is "true" only for the open-core image pushed to
# GHCR by the public docker-publish workflow (that image — and only that image —
# has a registry update channel). The cloud image and local/source runs leave
# PUBLISHED at its default. See apps/api/src/lib/app-build-info.ts.
ARG PRINTSTREAM_IMAGE_REVISION=unknown
ARG PRINTSTREAM_IMAGE_PUBLISHED=false
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bridge/package.json apps/bridge/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/bridge-runtime/package.json packages/bridge-runtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
RUN npm ci
COPY . .
# Image-drift fingerprint: covers what app-bundle self-updates cannot deliver —
# the dependency tree baked into node_modules and this Dockerfile (base image,
# apt ffmpeg). App sources are excluded (bundles keep code lockstep, so hashing
# sources would re-flag every self-built image). The bridge *release* fingerprint
# (lockstep identity, bridge-release-fingerprint.sh) hashes sources separately
# and is unaffected by this Dockerfile.
RUN bridge_source_fingerprint="$PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT" \
  && if [ "$bridge_source_fingerprint" = "unknown" ]; then \
    bridge_source_fingerprint="$(find package-lock.json Dockerfile -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"; \
  fi \
  && bridge_release_fingerprint="$(bash scripts/bridge-release-fingerprint.sh 2>/dev/null || echo unknown)" \
  && printf '{"bridgeBuildRevision":"%s","bridgeSourceFingerprint":"%s","bridgeReleaseFingerprint":"%s"}\n' "$BRIDGE_BUILD_REVISION" "$bridge_source_fingerprint" "$bridge_release_fingerprint" > bridge-build-metadata.json
# App-image identity for the footer version/update hint (read at runtime by the API).
RUN printf '{"revision":"%s","published":"%s"}\n' "$PRINTSTREAM_IMAGE_REVISION" "$PRINTSTREAM_IMAGE_PUBLISHED" > app-build-metadata.json
# prisma.config.ts requires DATABASE_URL even though `generate` never connects;
# a placeholder satisfies it at build time. The real URL comes from the runtime
# environment (compose `db` service / DATABASE_URL).
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" npm run db:generate
RUN npm run build --workspace @printstream/shared \
  && npm run build --workspace @printstream/bridge-runtime \
  && npm run build --workspace @printstream/web \
  && npm run build --workspace @printstream/api \
  && npm run build --workspace @printstream/bridge

FROM base AS runtime
ENV NODE_ENV=production
# Serve the embedded web SPA from this image by default (the `api` role).
ENV SERVE_WEB_DIR=/app/apps/web/dist
WORKDIR /app
# /run/provision holds the managed-bridge provisioning token; owning the
# mountpoint as `node` lets a fresh named volume inherit that ownership.
RUN mkdir -p /data /run/provision && chown -R node:node /data /run/provision
COPY --chown=node:node --from=build /app /app
COPY --chown=node:node docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN chmod +x /usr/local/bin/app-entrypoint.sh
USER node
EXPOSE 4000
ENTRYPOINT ["app-entrypoint.sh"]
CMD ["api"]
