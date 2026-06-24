#!/bin/sh
set -eu

# Unified BambuStudio CLI launcher.
#
# BambuStudio ships x86-64 binaries only. On an x86-64 host we exec the extracted AppImage's
# AppRun natively. On a non-x86 host (arm64 — Raspberry Pi / ARM NAS in production, Windows on
# ARM / WSL / Apple silicon in dev) there is no native slicer, so we run the bundled
# bin/bambu-studio through qemu-user emulation against an x86-64 sysroot (built by
# build-x86-sysroot.mjs; QEMU_LD_PREFIX points at it). Both paths run under Xvfb so the
# offscreen GL that renders plate thumbnails has a display.
#
# This one script is shipped in the production image (Dockerfile cliPath) and used by dev
# (scripts/dev/setup-slicer-qemu.mjs points the arm64 dev target's cliPath here).

appdir="${SLICER_APPDIR:-${BAMBUSTUDIO_APPDIR:-/opt/bambustudio/squashfs-root}}"
export HOME="${HOME:-/tmp/printstream-bambustudio-home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}"
# Force X11 + software GL so the offscreen GL used for plate thumbnails can init under
# Xvfb. Without this glfw tries Wayland (no display) and aborts with glfwInit error,
# which leaves the sliced gcode.3mf without a thumbnail.
export GDK_BACKEND="${GDK_BACKEND:-x11}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
export GALLIUM_DRIVER="${GALLIUM_DRIVER:-llvmpipe}"
unset WAYLAND_DISPLAY 2>/dev/null || true

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
      ln -s "$src" "$dest"
    fi
  done
fi

machine="$(uname -m 2>/dev/null || echo unknown)"

if [ "$machine" = "x86_64" ] || [ "$machine" = "amd64" ]; then
  # Native x86-64: AppRun sets LD_LIBRARY_PATH=$appdir/bin + LC_ALL=C and execs bin/bambu-studio.
  if command -v xvfb-run >/dev/null 2>&1; then
    # Start Xvfb with GLX so the offscreen GL context can be created for thumbnails.
    exec xvfb-run -a -s "-screen 0 1280x1024x24 +extension GLX +render -nolisten tcp" "$appdir/AppRun" "$@"
  fi
  exec "$appdir/AppRun" "$@"
fi

# Non-x86 host: emulate. Mirror what AppRun sets, but run bin/bambu-studio under qemu-user
# against the x86-64 sysroot (loader + GTK/WebKit/Mesa libs the AppImage does not bundle).
sysroot="${SLICER_QEMU_SYSROOT:-/opt/printstream-slicer-x86root}"
export QEMU_LD_PREFIX="$sysroot"
export LD_LIBRARY_PATH="$appdir/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Load the x86-64 Mesa DRI/llvmpipe drivers from the sysroot, not any host arm64 ones.
export LIBGL_DRIVERS_PATH="${LIBGL_DRIVERS_PATH:-$sysroot/usr/lib/x86_64-linux-gnu/dri}"
export LC_ALL=C
qemu="${SLICER_QEMU_BIN:-qemu-x86_64-static}"
bin="$appdir/bin/bambu-studio"

if command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a -s "-screen 0 1280x1024x24 +extension GLX +render -nolisten tcp" "$qemu" "$bin" "$@"
fi

exec "$qemu" "$bin" "$@"
