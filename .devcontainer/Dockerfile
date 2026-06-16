# Debian Trixie (glibc 2.38), pinned — NOT the floating `1-20-bookworm` (glibc 2.36): the
# in-workspace slicer (PRINTSTREAM_DEV_SLICER=workspace) runs the bundled BambuStudio CLI, and the
# pinned 2.7.x build needs glibc 2.38 / GLIBCXX_3.4.32. This matches the slicer image's own
# `node:22-trixie` base, so the runtime libs installed below line up with that proven setup.
# (MCR has no floating `1-20-trixie` alias yet, hence the explicit version pin.)
FROM mcr.microsoft.com/devcontainers/typescript-node:4.0.6-20-trixie

ARG DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bat \
      ca-certificates \
      curl \
      docker.io \
      fd-find \
      ffmpeg \
      gh \
      git \
      htop \
      jq \
      less \
      nsis \
      postgresql-client \
      ripgrep \
      squashfs-tools \
      tree \
      unzip \
      wine \
      xorriso; \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
    ln -sf /usr/bin/batcat /usr/local/bin/bat; \
    rm -rf /var/lib/apt/lists/*

# Runtime libraries for the in-workspace slicer (opt-in: PRINTSTREAM_DEV_SLICER=workspace).
# Mirrors the runtime stage of apps/slicer/Dockerfile so the BambuStudio CLI can run here.
# amd64-only: BambuStudio is x86, and the symlinks below are x86 paths — on arm64 we skip this
# (those devs run dev against a remote x86 slicer). Keeping it gated avoids bloating arm64 images.
RUN set -eux; \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        libasound2 libdbus-1-3 libegl1 libfuse2 libgl1 libglu1-mesa \
        libgstreamer-plugins-base1.0-0 libgstreamer1.0-0 libglib2.0-0 libgtk-3-0 \
        libjavascriptcoregtk-4.1-0 libmspack0 libnss3 libopengl0 libsoup-3.0-0 \
        libwebkit2gtk-4.1-0 libxkbcommon0 libxss1 xauth xvfb; \
      ln -sf /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 /lib/x86_64-linux-gnu/libwebkit2gtk-4.0.so.37; \
      ln -sf /lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0 /lib/x86_64-linux-gnu/libjavascriptcoregtk-4.0.so.18; \
      rm -rf /var/lib/apt/lists/*; \
    fi

# arm64 (Windows on ARM / WSL, Apple silicon, etc.): BambuStudio is x86-only, so the in-workspace slicer runs the x86-64 CLI
# under qemu-user emulation (scripts/dev/setup-slicer-qemu.mjs builds the x86-64 sysroot into the
# slicer data volume on first `npm run dev`). Bake the emulator + Xvfb here so they survive
# rebuilds; the x86-64 GTK/WebKit/Mesa runtime is supplied by the sysroot, not this image.
RUN set -eux; \
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        qemu-user-static xauth xvfb; \
      rm -rf /var/lib/apt/lists/*; \
    fi

# Persist bash history to a named volume mounted at /commandhistory so it
# survives devcontainer rebuilds. The volume is declared in compose.persist.yml.
RUN set -eux; \
    mkdir -p /commandhistory; \
    touch /commandhistory/.bash_history; \
    chown -R node:node /commandhistory; \
    printf '\n# Persist bash history across devcontainer rebuilds.\nexport HISTFILE=/commandhistory/.bash_history\nexport PROMPT_COMMAND="history -a; ${PROMPT_COMMAND:-}"\n' >> /home/node/.bashrc

# Pre-create the persisted home directories (Claude data + VS Code Server
# extensions) so the named volumes mounted there inherit node ownership
# instead of coming up owned by root.
RUN set -eux; \
    mkdir -p /home/node/.claude /home/node/.vscode-server/extensions /home/node/.printstream-slicer; \
    chown -R node:node /home/node/.claude /home/node/.vscode-server /home/node/.printstream-slicer
