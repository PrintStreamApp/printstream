#!/bin/sh
# Slicer container entrypoint.
#
# The slicer runs as the unprivileged `node` user (uid 1000), but its scratch dir
# `$SLICER_WORK_DIR` (/work) is a persistent named volume. A volume first created by
# an older *root*-running slicer image stays root-owned even after the image starts
# running as `node`, so the process hits `EACCES: permission denied, mkdir /work/<job>`
# when creating per-slice scratch. To self-heal that (instead of requiring an operator
# to recreate the volume), we start as root, fix ownership of the work dir, then drop
# to `node` via gosu. Fresh volumes already inherit `node` ownership from the image, so
# the recursive chown only runs when the dir is actually mis-owned (cheap on every
# normal boot).
set -e

WORK="${SLICER_WORK_DIR:-/work}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$WORK"
  if [ "$(stat -c '%U' "$WORK")" != "node" ]; then
    echo "[slicer-entrypoint] work dir $WORK is not node-owned; healing with chown -R node:node"
    chown -R node:node "$WORK"
  fi
  exec gosu node "$@"
fi

# Already unprivileged (e.g. an explicit `user:` override) — just run the command.
exec "$@"
