FROM node:22-trixie-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/slicer/package.json apps/slicer/package.json
RUN npm install --omit=dev --workspace @printstream/slicer --workspace @printstream/shared

FROM base AS build
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/slicer apps/slicer
RUN npm install --workspace @printstream/slicer --workspace @printstream/shared
RUN npm run build --workspace @printstream/shared && npm run build --workspace @printstream/slicer

FROM base AS slicer-targets
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates libfuse2 squashfs-tools \
	&& rm -rf /var/lib/apt/lists/*
COPY apps/slicer/docker/slicer-targets.mjs /usr/local/bin/slicer-targets.mjs
COPY apps/slicer/docker/install-slicer-targets.mjs /usr/local/bin/install-slicer-targets.mjs
COPY apps/slicer/docker/generate-bambustudio-full-profiles.mjs /usr/local/bin/generate-bambustudio-full-profiles.mjs
COPY apps/slicer/docker/bambu-studio-cli.sh /usr/local/bin/slicer-cli
RUN chmod +x /usr/local/bin/slicer-cli \
	&& node /usr/local/bin/install-slicer-targets.mjs /opt/printstream-slicers /usr/local/bin/slicer-cli

FROM base AS runtime
ENV NODE_ENV=production
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		libasound2 \
		libdbus-1-3 \
		libegl1 \
		libfuse2 \
		libgl1 \
		libglu1-mesa \
		libgstreamer-plugins-base1.0-0 \
		libgstreamer1.0-0 \
		libglib2.0-0 \
		libgtk-3-0 \
		libjavascriptcoregtk-4.1-0 \
		libmspack0 \
		libnss3 \
		libopengl0 \
		libsoup-3.0-0 \
		libwebkit2gtk-4.1-0 \
		libxkbcommon0 \
		libxss1 \
		xauth \
		xvfb \
	&& ln -sf /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 /lib/x86_64-linux-gnu/libwebkit2gtk-4.0.so.37 \
	&& ln -sf /lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0 /lib/x86_64-linux-gnu/libjavascriptcoregtk-4.0.so.18 \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/apps/slicer/dist apps/slicer/dist
COPY --from=build /app/apps/slicer/package.json apps/slicer/package.json
COPY --from=slicer-targets /opt/printstream-slicers /opt/printstream-slicers
COPY apps/slicer/docker/bambu-studio-cli.sh /usr/local/bin/bambu-studio-cli
COPY apps/slicer/docker/bambu-studio-cli.sh /usr/local/bin/slicer-cli
RUN chmod +x /usr/local/bin/bambu-studio-cli /usr/local/bin/slicer-cli
# Ship the third-party license notices alongside the bundled (AGPL-3.0) slicer
# binaries and npm deps. Required to distribute the engines and to answer the
# AGPL network-source offer. Keep apps/slicer/THIRD-PARTY-NOTICES.txt current
# with `npm run notices`.
COPY apps/slicer/THIRD-PARTY-SLICERS.md apps/slicer/THIRD-PARTY-NOTICES.txt LICENSE /app/licenses/
WORKDIR /app/apps/slicer
EXPOSE 4010
CMD ["node", "dist/index.js"]
