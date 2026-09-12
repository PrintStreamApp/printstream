#!/bin/sh
# Slicer container entrypoint.
#
# The trusted service owns engine installation, while every hostile native job runs under a
# private numeric uid and gid. Non-job diagnostics use the static `slicer-engine` account. The
# engines directory comes from outside the image:
#
# - The engines directory (dirname of `$SLICER_TARGETS_FILE`, /data/engines) is a bind
#   mount in the shipped compose file, so the operator chooses which disk holds several
#   hundred MB per engine. A bind mount HIDES the image's `chown`, and Compose creates a
#   missing bind source as root:root, so on a fresh install the engine downloads fail
#   with EACCES. That failure is quiet by design (installing engines is best-effort and
#   must never block boot), which means without this the container reports healthy and
#   simply never gets an engine: slicing is unavailable with only a warning in the log.
#
# The service keeps root ownership of the engine tree and work root. Engines have all group/other
# write bits removed; each disposable work tree is accessible only to its job identity. A native
# parser compromise therefore cannot alter the executable or another job's files.
set -e

secure_directory() {
  dir="$1"
  label="$2"
  mode="$3"
  mkdir -p "$dir"
  if [ "$(stat -c '%U:%G' "$dir")" != "root:root" ]; then
    echo "[slicer-entrypoint] securing $label ownership at $dir"
    chown -R root:root "$dir"
  fi
  chmod "$mode" "$dir"
}

if [ "$(id -u)" = "0" ]; then
  # Native jobs receive private per-job groups. They may traverse this root to their own directory,
  # but cannot create, replace, or remove another job's top-level entry.
  secure_directory "${SLICER_WORK_DIR:-/work}" "work dir" 0755
  # Derived from the manifest path exactly as the app derives it (`enginesRoot()` in
  # src/engines/paths.ts), so relocating the manifest relocates the healing with it.
  TARGETS_FILE="${SLICER_TARGETS_FILE:-/data/engines/targets.json}"
  engines_dir="$(dirname "$TARGETS_FILE")"
  secure_directory "$engines_dir" "engines dir" 0755
  permissions_marker="$engines_dir/.runner-permissions-v1"
  if [ ! -f "$permissions_marker" ]; then
    # Existing installs may predate the runner split and carry node-owned or group-writable files.
    # Finish any old launch-time profile links before making the tree immutable, then traverse the
    # multi-GB tree once, including when only descendants have stale ownership.
    echo "[slicer-entrypoint] migrating installed engines to the native-runner boundary"
    for target_dir in "$engines_dir"/*; do
      bundled_profiles_dir="$target_dir/app/resources/profiles/BBL"
      generated_profiles_dir="$target_dir/profiles"
      if [ ! -d "$bundled_profiles_dir" ] || [ ! -d "$generated_profiles_dir" ]; then
        continue
      fi
      for profile_kind in machine_full process_full filament_full; do
        source_dir="$generated_profiles_dir/$profile_kind"
        destination="$bundled_profiles_dir/$profile_kind"
        if [ -d "$source_dir" ] && [ ! -e "$destination" ]; then
          ln -s "$source_dir" "$destination"
        fi
      done
    done
    chown -R root:root "$engines_dir"
    chmod -R go-w "$engines_dir"
    : > "$permissions_marker"
    chmod 0644 "$permissions_marker"
  fi
  exec "$@"
fi

# Native development may deliberately run the service unprivileged; engine children then inherit
# that same identity because setuid is unavailable outside the hardened container.
exec "$@"
