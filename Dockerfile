# Combined PrintStream app image. Builds the web SPA, the API, and the bridge in
# one image; the entrypoint (docker/app-entrypoint.sh) runs whichever role you
# point it at — `api` (default; serves web + /api + /ws on one port) or `bridge`.
# Using one image for the whole app keeps the cloud build and the published
# open-core image identical (no divergence). Runs as the unprivileged `node`
# user. PostgreSQL lives in the compose `db` service; `/data` stores library
# files, plugin storage, and other API-owned assets.
#
# NODE_VERSION is pinned to the EXACT version the SEA builds embed
# (DEFAULT_NODE_VERSION in packages/sea-runtime/scripts/build-harness.mjs) so
# every distribution ships the same runtime; bump BOTH together, deliberately.
# A floating `node:22` tag once let an image rebuild silently absorb a Node
# patch (22.23.x) whose TLS regression broke H2D FTPS only on Docker installs
# while SEA bridges kept working — never again.
ARG NODE_VERSION=22.22.3
FROM node:${NODE_VERSION}-bookworm-slim AS base
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
COPY packages/sea-runtime/package.json packages/sea-runtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
RUN npm ci
COPY . .
# Image-drift fingerprint: the dependency tree baked into node_modules and this
# Dockerfile (base image, apt ffmpeg) — the part of a Docker bridge that only an
# image rebuild/pull can change. App sources are excluded (the bridge *release*
# fingerprint, bridge-release-fingerprint.sh, covers those separately; hashing
# sources here would re-flag every self-built image). Drift feeds the
# non-blocking imageUpdateRequired warning shown in Settings.
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
  && npm run build --workspace @printstream/sea-runtime \
  && npm run build --workspace @printstream/web \
  && npm run build --workspace @printstream/api \
  && npm run build --workspace @printstream/bridge

# Slim, bridge-only image, published as ghcr.io/printstreamapp/printstream-bridge
# for running just a LAN bridge host. The bridge has a tiny dependency footprint
# (no Prisma, web, or API deps), so we esbuild-bundle its runtime entry into a
# single file (bundle-docker.mjs) and ship it on the base image — which already
# carries the ffmpeg the camera relay needs — instead of copying the full
# workspace node_modules the combined `runtime` stage does. The entrypoint is the
# LAUNCHER, which activates signed single-file app bundles from /data/releases
# (in-place self-update, lockstep with the paired server) and falls back to the
# image-baked runner; base-image drift still ships by image pull. The combined
# image can still run the bridge via its `bridge` role (no self-update there);
# this is the dedicated, smaller alternative. Build with
# `docker build --target bridge`.
FROM build AS bridge-build
RUN node apps/bridge/scripts/bundle-docker.mjs

FROM base AS bridge
ARG NODE_VERSION
ENV NODE_ENV=production
# Enable the bundle self-update driver (the launcher below can activate what it
# installs) and converge automatically, matching the standalone packaging.
ENV BRIDGE_BUNDLE_SELF_UPDATE=true
ENV BRIDGE_AUTO_UPDATE=true
# The runner ABI embeds the EXACT pinned Node version: an app bundle installs
# only onto a runner with an identical runtime, so new JS never runs on a
# different Node than it was built for (see the NODE_VERSION note at the top).
ENV BRIDGE_RUNNER_ABI_VERSION=node${NODE_VERSION}-ffmpeg7-v1
WORKDIR /app
# Library files, bridge state, and other bridge-owned assets live under /data.
RUN mkdir -p /data && chown -R node:node /data
COPY --chown=node:node --from=bridge-build /app/apps/bridge/dist/bridge-runner.cjs /app/bridge-runner.cjs
COPY --chown=node:node --from=bridge-build /app/apps/bridge/dist/bridge-launcher.cjs /app/bridge-launcher.cjs
# Build identity for the footer version/update hint (env.ts reads it from cwd).
COPY --chown=node:node --from=bridge-build /app/bridge-build-metadata.json /app/bridge-build-metadata.json
USER node
ENTRYPOINT ["node", "/app/bridge-launcher.cjs"]

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
