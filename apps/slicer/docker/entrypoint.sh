#!/bin/sh
# Slicer container entrypoint.
#
# The slicer runs as the unprivileged `node` user (uid 1000), but two of its directories
# come from OUTSIDE the image, where the image's own ownership does not apply:
#
# - `$SLICER_WORK_DIR` (/work) is a persistent named volume. A volume first created by
#   an older *root*-running slicer image stays root-owned even after the image starts
#   running as `node`, so the process hits `EACCES: permission denied, mkdir /work/<job>`
#   when creating per-slice scratch.
# - The engines directory (dirname of `$SLICER_TARGETS_FILE`, /data/engines) is a BIND
#   mount in the shipped compose file, so the operator chooses which disk holds several
#   hundred MB per engine. A bind mount HIDES the image's `chown`, and Compose creates a
#   missing bind source as root:root, so on a fresh install the engine downloads fail
#   with EACCES. That failure is quiet by design (installing engines is best-effort and
#   must never block boot), which means without this the container reports healthy and
#   simply never gets an engine: slicing is unavailable with only a warning in the log.
#
# To self-heal both (instead of requiring an operator to fix ownership by hand), we start
# as root, fix ownership, then drop to `node` via gosu. Each check is guarded so the
# recursive chown only runs when the directory is actually mis-owned: the engines tree is
# multiple GB once populated, and chowning it on every boot would be a real cost.
set -e

heal_owner() {
  dir="$1"
  label="$2"
  mkdir -p "$dir"
  if [ "$(stat -c '%U' "$dir")" != "node" ]; then
    echo "[slicer-entrypoint] $label $dir is not node-owned; healing with chown -R node:node"
    chown -R node:node "$dir"
  fi
}

if [ "$(id -u)" = "0" ]; then
  heal_owner "${SLICER_WORK_DIR:-/work}" "work dir"
  # Derived from the manifest path exactly as the app derives it (`enginesRoot()` in
  # src/engines/paths.ts), so relocating the manifest relocates the healing with it.
  TARGETS_FILE="${SLICER_TARGETS_FILE:-/data/engines/targets.json}"
  heal_owner "$(dirname "$TARGETS_FILE")" "engines dir"
  exec gosu node "$@"
fi

# Already unprivileged (e.g. an explicit `user:` override); just run the command.
exec "$@"
