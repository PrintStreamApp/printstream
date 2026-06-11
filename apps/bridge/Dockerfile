FROM node:22-bookworm-slim AS build
ARG BRIDGE_BUILD_REVISION=unknown
ARG BRIDGE_SOURCE_FINGERPRINT=unknown
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bridge/package.json apps/bridge/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/bridge-runtime/package.json packages/bridge-runtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
RUN npm ci
COPY . .
RUN bridge_source_fingerprint="$BRIDGE_SOURCE_FINGERPRINT" \
	&& if [ "$bridge_source_fingerprint" = "unknown" ]; then \
		bridge_source_fingerprint="$(find apps/bridge/src packages/bridge-runtime/src packages/shared/src apps/bridge/tsconfig.json packages/bridge-runtime/tsconfig.json packages/shared/tsconfig.json tsconfig.base.json package-lock.json -type f ! -path 'packages/shared/src/private/*' ! -path 'apps/bridge/src/demo-*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"; \
	fi \
	&& printf '{"bridgeBuildRevision":"%s","bridgeSourceFingerprint":"%s"}\n' "$BRIDGE_BUILD_REVISION" "$bridge_source_fingerprint" > bridge-build-metadata.json
RUN npm run build --workspace @printstream/shared \
	&& npm run build --workspace @printstream/bridge-runtime \
	&& npm run build --workspace @printstream/bridge

FROM node:22-bookworm-slim AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data \
	&& chown -R node:node /data
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=build /app/bridge-build-metadata.json ./bridge-build-metadata.json
COPY --chown=node:node --from=build /app/apps/bridge/package.json ./apps/bridge/package.json
COPY --chown=node:node --from=build /app/packages/bridge-runtime/package.json ./packages/bridge-runtime/package.json
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/package.json
RUN npm ci --omit=dev --workspace @printstream/bridge --include-workspace-root=false --ignore-scripts
COPY --chown=node:node --from=build /app/apps/bridge/package.json ./apps/bridge/package.json
COPY --chown=node:node --from=build /app/apps/bridge/dist ./apps/bridge/dist
COPY --chown=node:node --from=build /app/packages/bridge-runtime/package.json ./packages/bridge-runtime/package.json
COPY --chown=node:node --from=build /app/packages/bridge-runtime/dist ./packages/bridge-runtime/dist
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
RUN find apps/bridge/dist packages/bridge-runtime/dist packages/shared/dist \
	\( -name '*.test.js' -o -name '*.test.d.ts' \) -delete \
	&& rm -f package.json package-lock.json
USER node

FROM runtime-base AS demo-runtime
CMD ["node", "apps/bridge/dist/demo-index.js"]

FROM runtime-base AS runtime
USER root
RUN rm -f \
	apps/bridge/dist/demo-index.js \
	apps/bridge/dist/demo-simulator.js
USER node
CMD ["node", "apps/bridge/dist/launcher.js"]