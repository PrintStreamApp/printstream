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

# Build an x86-64 sysroot for the arm64 image. BambuStudio is x86-only, so on arm64
# the slicer runs the same x86-64 CLI under qemu-user (mirroring the dev arm64 path) —
# the sysroot supplies the x86-64 loader + GTK/WebKit/Mesa libs the AppImage does not
# bundle. On amd64 this stage produces an empty dir (the runtime installs native libs),
# so the `COPY --from` below is a harmless no-op there. TARGETARCH is set by buildx.
FROM base AS x86-sysroot
ARG TARGETARCH
ARG DEBIAN_FRONTEND=noninteractive
COPY apps/slicer/docker/build-x86-sysroot.mjs /usr/local/bin/build-x86-sysroot.mjs
RUN set -eux; \
	mkdir -p /opt/printstream-slicer-x86root; \
	if [ "$TARGETARCH" = "arm64" ]; then \
		apt-get update; \
		apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
		rm -rf /var/lib/apt/lists/*; \
		node /usr/local/bin/build-x86-sysroot.mjs /opt/printstream-slicer-x86root /tmp/x86root-cache; \
		rm -rf /tmp/x86root-cache; \
	fi

FROM base AS runtime
ENV NODE_ENV=production
ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
# amd64: install the native GTK/WebKit/Mesa closure BambuStudio links (the AppImage does
# not bundle it). arm64: the x86-64 CLI runs under qemu-user against the baked sysroot, so
# install the emulator + the native tools (Xvfb/gosu) only; the x86-64 libs come from the
# sysroot copied in below.
RUN set -eux; \
	apt-get update; \
	if [ "$TARGETARCH" = "arm64" ]; then \
		apt-get install -y --no-install-recommends \
			ca-certificates gosu qemu-user-static xauth xvfb; \
	else \
		apt-get install -y --no-install-recommends \
			ca-certificates \
			gosu \
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
			xvfb; \
		ln -sf /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 /lib/x86_64-linux-gnu/libwebkit2gtk-4.0.so.37; \
		ln -sf /lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0 /lib/x86_64-linux-gnu/libjavascriptcoregtk-4.0.so.18; \
	fi; \
	rm -rf /var/lib/apt/lists/*
# The launcher (bambu-studio-cli.sh) reads SLICER_QEMU_SYSROOT on arm64; harmless on amd64.
ENV SLICER_QEMU_SYSROOT=/opt/printstream-slicer-x86root
COPY --from=x86-sysroot /opt/printstream-slicer-x86root /opt/printstream-slicer-x86root
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/apps/slicer/dist apps/slicer/dist
COPY --from=build /app/apps/slicer/package.json apps/slicer/package.json
# Owned by the unprivileged `node` user (see USER below): the CLI launcher symlinks
# generated profiles into the extracted slicer's resources/profiles/BBL at runtime,
# so that tree must be writable by the runtime user.
COPY --from=slicer-targets --chown=node:node /opt/printstream-slicers /opt/printstream-slicers
COPY apps/slicer/docker/bambu-studio-cli.sh /usr/local/bin/bambu-studio-cli
COPY apps/slicer/docker/bambu-studio-cli.sh /usr/local/bin/slicer-cli
RUN chmod +x /usr/local/bin/bambu-studio-cli /usr/local/bin/slicer-cli
COPY apps/slicer/docker/entrypoint.sh /usr/local/bin/slicer-entrypoint.sh
RUN chmod +x /usr/local/bin/slicer-entrypoint.sh
# Ship the third-party license notices alongside the bundled (AGPL-3.0) slicer
# binaries and npm deps. Required to distribute the engines and to answer the
# AGPL network-source offer. Keep apps/slicer/THIRD-PARTY-NOTICES.txt current
# with `npm run notices`.
COPY apps/slicer/THIRD-PARTY-SLICERS.md apps/slicer/THIRD-PARTY-NOTICES.txt LICENSE /app/licenses/
# Create the work dir owned by `node` so a freshly-created named volume mounted
# here (compose sets SLICER_WORK_DIR=/work) inherits that ownership and the
# unprivileged process can write its slicing scratch. A work volume created by an
# older root-running image stays root-owned; the entrypoint (see below) self-heals
# that on boot, so no manual volume recreation is needed.
RUN mkdir -p /work && chown node:node /work \
	# Xvfb needs the X11 socket dir to exist and be world-writable; create it now
	# so the unprivileged user can bind a display (running as root used to create
	# it implicitly).
	&& mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
WORKDIR /app/apps/slicer
EXPOSE 4010
# Drop privileges: the slicer runs a large third-party native binary (BambuStudio)
# over arbitrary user-supplied 3MF geometry — the highest-risk untrusted-input
# surface in the stack. The AppImage is extracted at build time and run directly
# (no FUSE needed at runtime), and work/home dirs live under /work (or /tmp), so
# the CLI runs fine unprivileged. `node` (uid 1000) ships with the base image.
# The container STARTS as root so the entrypoint can fix a stale root-owned work
# volume, then drops to `node` via gosu before exec'ing the CMD — so the slicer
# itself never runs as root.
ENTRYPOINT ["/usr/local/bin/slicer-entrypoint.sh"]
CMD ["node", "dist/index.js"]
