# NODE_VERSION mirrors the root Dockerfile / DEFAULT_NODE_VERSION in
# packages/sea-runtime/scripts/build-harness.mjs: one Node across every
# distribution, bumped deliberately (see the root Dockerfile's note).
# Trixie (not bookworm) because the bundled BambuStudio CLI needs glibc 2.38.
ARG NODE_VERSION=22.22.3
FROM node:${NODE_VERSION}-trixie-slim AS base
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
# --include-workspace-root: the TypeScript compiler (the root tsc/tsc6 alias pair) lives in
# the ROOT devDependencies since the TS7 toolchain change, so a workspace-scoped install
# alone leaves the build stage without tsc.
RUN npm install --include-workspace-root --workspace @printstream/slicer --workspace @printstream/shared
RUN npm run build --workspace @printstream/shared && npm run build --workspace @printstream/slicer

# Build an x86-64 sysroot for the arm64 image. BambuStudio is x86-only, so on arm64
# the slicer runs the same x86-64 CLI under qemu-user (mirroring the dev arm64 path):
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

# Compile the offscreen-GL preload shim (see docker/gl-osmesa-shim.c). The CLI is x86-64 on
# BOTH image arches, so the shim always targets x86-64: native gcc on amd64, the cross
# compiler on arm64 (where it is preloaded into the qemu-emulated guest).
FROM base AS glshim
ARG TARGETARCH
ARG DEBIAN_FRONTEND=noninteractive
COPY apps/slicer/docker/gl-osmesa-shim.c /tmp/gl-osmesa-shim.c
RUN set -eux; \
	apt-get update; \
	if [ "$TARGETARCH" = "arm64" ]; then \
		apt-get install -y --no-install-recommends gcc-x86-64-linux-gnu libc6-dev-amd64-cross; \
		x86_64-linux-gnu-gcc -shared -fPIC -O2 -o /tmp/gl-osmesa-shim.so /tmp/gl-osmesa-shim.c; \
	else \
		apt-get install -y --no-install-recommends gcc libc6-dev; \
		gcc -shared -fPIC -O2 -o /tmp/gl-osmesa-shim.so /tmp/gl-osmesa-shim.c; \
	fi; \
	rm -rf /var/lib/apt/lists/*

FROM base AS runtime
ENV NODE_ENV=production
ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
# amd64: install the native GTK/WebKit/Mesa closure BambuStudio links (the AppImage does
# not bundle it). arm64: the x86-64 CLI runs under qemu-user against the baked sysroot, so
# install the emulator + the native tools (gosu/weston) only; the x86-64 libs come from
# the sysroot copied in below. `weston` (native on both arches: Wayland is a socket
# protocol, so an arm64 compositor serves the emulated x86-64 client) and amd64's
# `libosmesa6` are the launcher's offscreen-GL pieces for plate thumbnail rendering; see
# bambu-studio-cli.sh. No X server: the CLI never initialises GTK in CLI mode, and the
# Xvfb this image used to carry only leaked an unreaped zombie per invocation.
RUN set -eux; \
	apt-get update; \
	if [ "$TARGETARCH" = "arm64" ]; then \
		apt-get install -y --no-install-recommends \
			ca-certificates gosu qemu-user-static weston; \
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
			libosmesa6 \
			libsoup-3.0-0 \
			libwebkit2gtk-4.1-0 \
			libxkbcommon0 \
			libxss1 \
			weston; \
		ln -sf /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 /lib/x86_64-linux-gnu/libwebkit2gtk-4.0.so.37; \
		ln -sf /lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0 /lib/x86_64-linux-gnu/libjavascriptcoregtk-4.0.so.18; \
	fi; \
	rm -rf /var/lib/apt/lists/*
# Needed to UNPACK an engine, which now happens at runtime rather than at build.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libfuse2 squashfs-tools \
	&& rm -rf /var/lib/apt/lists/*
# The launcher (bambu-studio-cli.sh) reads SLICER_QEMU_SYSROOT on arm64; harmless on amd64.
ENV SLICER_QEMU_SYSROOT=/opt/printstream-slicer-x86root
COPY --from=x86-sysroot /opt/printstream-slicer-x86root /opt/printstream-slicer-x86root
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/apps/slicer/dist apps/slicer/dist
COPY --from=build /app/apps/slicer/package.json apps/slicer/package.json
# The engine manager reads the pinned engine list and download matrix from these
# two, and the compiled `dist/engines/catalogue.js` resolves them as a RELATIVE
# path out of `dist`. Copying `dist` alone therefore ships code that cannot
# import its own data, and the service crash-loops on ERR_MODULE_NOT_FOUND.
# They stay outside `src` on purpose: the image build bakes engines in from the
# same files, so one list serves both. `runtime-assets.test.ts` fails if a new
# such import is added without a COPY here.
COPY apps/slicer/docker/slicer-targets.mjs apps/slicer/docker/slicer-targets.mjs
COPY apps/slicer/docker/engine-assets.mjs apps/slicer/docker/engine-assets.mjs
COPY apps/slicer/docker/generate-bambustudio-full-profiles.mjs apps/slicer/docker/generate-bambustudio-full-profiles.mjs
# Engines are NOT baked in. They are downloaded by the same installer the native
# app uses, into SLICER_TARGETS_FILE's directory: a bind mount, so the operator
# chooses which disk carries them and a removal survives a container recreate.
# Baking them cost 4 GB of image for a set the operator could not change: install
# was impossible (it demanded a runtime closure this image neither ships nor
# needs) and remove was undone by the next recreate.
ENV SLICER_ENGINE_LAUNCH=container
ENV SLICER_TARGETS_FILE=/data/engines/targets.json
RUN mkdir -p /data/engines && chown -R node:node /data/engines
COPY apps/slicer/docker/bambu-studio-cli.sh /usr/local/bin/bambu-studio-cli
COPY apps/slicer/docker/bambu-studio-cli.sh /usr/local/bin/slicer-cli
RUN chmod +x /usr/local/bin/bambu-studio-cli /usr/local/bin/slicer-cli
# Next to the launcher: its default shim lookup is "beside this script" (SLICER_GL_SHIM
# overrides). Always x86-64, matching the CLI, on both image arches.
COPY --from=glshim /tmp/gl-osmesa-shim.so /usr/local/bin/gl-osmesa-shim.so
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
RUN mkdir -p /work && chown node:node /work
WORKDIR /app/apps/slicer
EXPOSE 4010
# Drop privileges: the slicer runs a large third-party native binary (BambuStudio)
# over arbitrary user-supplied 3MF geometry, the highest-risk untrusted-input
# surface in the stack. The AppImage is extracted at build time and run directly
# (no FUSE needed at runtime), and work/home dirs live under /work (or /tmp), so
# the CLI runs fine unprivileged. `node` (uid 1000) ships with the base image.
# The container STARTS as root so the entrypoint can fix a stale root-owned work
# volume, then drops to `node` via gosu before exec'ing the CMD, so the slicer
# itself never runs as root.
ENTRYPOINT ["/usr/local/bin/slicer-entrypoint.sh"]
CMD ["node", "dist/main.js"]
