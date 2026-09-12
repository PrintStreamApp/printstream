#!/bin/sh
set -eu

# Unified BambuStudio CLI launcher.
#
# BambuStudio ships x86-64 binaries only. On an x86-64 host we run the extracted AppImage's
# binary natively. On a non-x86 host (arm64: Raspberry Pi / ARM NAS in production, Windows on
# ARM / WSL / Apple silicon in dev) there is no native slicer, so we run the bundled
# bin/bambu-studio through qemu-user emulation against an x86-64 sysroot (built by
# build-x86-sysroot.mjs; QEMU_LD_PREFIX points at it).
#
# No X server is involved: the CLI never initialises GTK in CLI mode (verified: full
# slices and settings exports run with no DISPLAY at all, matching the native app's
# launcher, engines/launcher.ts). The Xvfb this script used to run was based on a wrong
# premise and leaked one unreaped Xvfb zombie per invocation via xvfb-run.
#
# What thumbnail rendering DOES need is an offscreen GL stack. When a headless Wayland
# compositor and the GL shim are available, the CLI renders real plate thumbnails into its
# sliced output. Three pieces are required, one per layer the CLI's renderer fails on (see
# gl-osmesa-shim.c for the full mechanism):
#
#   1. A Wayland display (private headless Weston, spawned per invocation below): the
#      bundled GLFW 3.3.7 is compiled Wayland-only, so glfwInit can NEVER be satisfied by
#      Xvfb/X11, only by a Wayland socket.
#   2. libOSMesa (installed natively on amd64, in the sysroot on arm64): the CLI forces a
#      software OSMesa GL context on Linux.
#   3. gl-osmesa-shim.so (LD_PRELOAD, x86-64): gets the CLI's GLX-built GLEW past init and
#      routes its GL dispatch to the OSMesa context.
#
# Each piece degrades gracefully: if weston, the shim, or libOSMesa is missing, the CLI
# skips thumbnail generation exactly as it always did (exit 0, gcode intact) and the
# service backfills covers from the input file. Never let thumbnail plumbing fail a slice.
#
# This one script is shipped in the production image (Dockerfile cliPath) and used by dev
# (scripts/dev/setup-slicer*.mjs point the dev targets' cliPath here).

appdir="${SLICER_APPDIR:-${BAMBUSTUDIO_APPDIR:-/opt/bambustudio/squashfs-root}}"
export HOME="${HOME:-/tmp/printstream-bambustudio-home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
# Software GL keeps llvmpipe rendering deterministic across hosts.
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
export GALLIUM_DRIVER="${GALLIUM_DRIVER:-llvmpipe}"

# POSIX file-size limits stop a hostile project before its G-code fills the bounded work filesystem.
# The service supplies 512-byte blocks from its trusted output ceiling; the API cannot widen it.
if [ -n "${SLICER_MAX_FILE_BLOCKS:-}" ]; then
  ulimit -f "$SLICER_MAX_FILE_BLOCKS"
fi

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"

# Generated machine/process/filament presets are stored at <target>/profiles/*.
# Bambu CLI resolves embedded preset IDs via app/resources/profiles/BBL/*_full.
target_dir=$(dirname "$appdir")
generated_profiles="$target_dir/profiles"
bbl_profiles_dir="$appdir/resources/profiles/BBL"

if [ -d "$generated_profiles" ] && [ -d "$bbl_profiles_dir" ]; then
  for profile_kind in machine_full process_full filament_full; do
    src="$generated_profiles/$profile_kind"
    dest="$bbl_profiles_dir/$profile_kind"
    if [ -d "$src" ] && [ ! -e "$dest" ]; then
      if [ -w "$bbl_profiles_dir" ]; then
        # Native development may use a legacy engine installed before profile links moved into the
        # trusted installer. The hardened container prepares them before dropping privileges.
        ln -s "$src" "$dest"
      else
        echo "bambu-studio-cli: required generated profile link is missing: $dest" >&2
        exit 1
      fi
    fi
  done
fi

# --- offscreen GL for plate thumbnails (see the header) -------------------------------
# The shim ships next to this script by default (dev data dir, image /usr/local/bin);
# SLICER_GL_SHIM overrides. Weston is spawned per invocation with a private runtime dir
# and socket, so concurrent slices never race, and reaped by the EXIT trap, which is why
# the CLI below is launched as the script's last command rather than exec'd.
gl_shim="${SLICER_GL_SHIM:-$(dirname "$0")/gl-osmesa-shim.so}"
weston_pid=""
weston_runtime_dir=""

cleanup_weston() {
  if [ -n "$weston_pid" ]; then
    kill "$weston_pid" 2>/dev/null || true
    # Reap it ourselves: the service container's PID 1 (node) never reaps orphans, so an
    # unreaped weston would leave one zombie per slice.
    wait "$weston_pid" 2>/dev/null || true
  fi
  if [ -n "$weston_runtime_dir" ]; then
    rm -rf "$weston_runtime_dir"
  fi
}

# Only the actions that render thumbnails get a compositor: the service also invokes this
# wrapper for --help probes and --export-settings, and a weston per those would be pure
# startup cost.
wants_thumbnail_gl=false
for arg in "$@"; do
  case "$arg" in
    --slice|--export-png) wants_thumbnail_gl=true ;;
  esac
done

unset WAYLAND_DISPLAY 2>/dev/null || true
if [ "$wants_thumbnail_gl" = true ] && [ -f "$gl_shim" ] && command -v weston >/dev/null 2>&1; then
  # Keep the socket path short: unix socket paths are capped at 108 bytes.
  weston_runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/ps-wl.XXXXXX")
  chmod 700 "$weston_runtime_dir"
  wayland_socket="wl-$$"
  # Weston's own output must not reach stdout/stderr: the slicer service parses the
  # CLI's output streams. kiosk-shell still provides the xdg-shell GLFW needs but spawns
  # none of desktop-shell's helper clients (weston-keyboard/weston-desktop-shell), which
  # would outlive weston as unreapable zombies: only weston itself is our child, and the
  # container's PID 1 (node) never reaps orphans.
  XDG_RUNTIME_DIR="$weston_runtime_dir" weston --no-config --backend=headless \
    --shell=kiosk-shell.so --socket="$wayland_socket" --idle-time=0 >/dev/null 2>&1 &
  weston_pid=$!
  # Signals route through `exit` so the EXIT trap reaps weston on every path.
  trap cleanup_weston EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  waited=0
  while [ ! -S "$weston_runtime_dir/$wayland_socket" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if [ -S "$weston_runtime_dir/$wayland_socket" ]; then
    export XDG_RUNTIME_DIR="$weston_runtime_dir"
    export WAYLAND_DISPLAY="$wayland_socket"
  else
    # Compositor never came up; drop back to the no-thumbnail path. Surfaced on stderr so
    # the failure is visible in the captured slice output rather than silent degradation.
    echo "bambu-studio-cli: weston did not come up; skipping plate thumbnail rendering" >&2
    cleanup_weston
    weston_pid=""
    weston_runtime_dir=""
    unset WAYLAND_DISPLAY 2>/dev/null || true
  fi
fi

machine="$(uname -m 2>/dev/null || echo unknown)"

if [ "$machine" = "x86_64" ] || [ "$machine" = "amd64" ]; then
  # Native x86-64: AppRun sets LD_LIBRARY_PATH=$appdir/bin + LC_ALL=C and execs
  # bin/bambu-studio. Launched as the script's last command (not exec'd) so the EXIT trap
  # can reap weston; a CLI signal death still surfaces as this script's 128+N exit.
  if [ -n "$weston_pid" ]; then
    env "LD_PRELOAD=$gl_shim" "$appdir/AppRun" "$@"
  else
    "$appdir/AppRun" "$@"
  fi
  exit $?
fi

# Non-x86 host: emulate. Mirror what AppRun sets, but run bin/bambu-studio under qemu-user
# against the x86-64 sysroot (loader + GTK/WebKit/Mesa/OSMesa libs the AppImage does not
# bundle).
sysroot="${SLICER_QEMU_SYSROOT:-/opt/printstream-slicer-x86root}"
export QEMU_LD_PREFIX="$sysroot"
export LD_LIBRARY_PATH="$appdir/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Load the x86-64 Mesa DRI/llvmpipe drivers from the sysroot, not any host arm64 ones.
export LIBGL_DRIVERS_PATH="${LIBGL_DRIVERS_PATH:-$sysroot/usr/lib/x86_64-linux-gnu/dri}"
export LC_ALL=C
qemu="${SLICER_QEMU_BIN:-qemu-x86_64-static}"
bin="$appdir/bin/bambu-studio"

# `-E` sets the variable in the EMULATED process only: the x86-64 shim must reach the
# guest ld.so without the host's (arm64) loader ever seeing it.
if [ -n "$weston_pid" ]; then
  "$qemu" -E "LD_PRELOAD=$gl_shim" "$bin" "$@"
else
  "$qemu" "$bin" "$@"
fi
exit $?
