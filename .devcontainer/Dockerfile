FROM mcr.microsoft.com/devcontainers/typescript-node:1-20-bookworm

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
    mkdir -p /home/node/.claude /home/node/.vscode-server/extensions; \
    chown -R node:node /home/node/.claude /home/node/.vscode-server
