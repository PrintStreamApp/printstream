#!/bin/sh
# arm64 dev wrapper: run the x86-64 BambuStudio CLI under qemu-user emulation.
#
# Mirrors apps/slicer/docker/bambu-studio-cli.sh (env + profile symlinks) but, instead of
# exec'ing AppRun natively, runs the bundled bin/bambu-studio through qemu-x86_64-static against
# an x86-64 glibc sysroot. BambuStudio ships x86-only, so on arm64 dev boxes (Windows on ARM / WSL,
# Apple silicon, etc.) this is the only way to run the slicer locally rather than via a remote x86 slicer.
#
# Provisioned by scripts/dev/setup-slicer-qemu.mjs: that script builds the sysroot
# ($SLICER_QEMU_SYSROOT, default <data>/x86root) and points a target's cliPath here.
set -eu

appdir="${SLICER_APPDIR:?SLICER_APPDIR must point at the extracted AppImage (.../app)}"
sysroot="${SLICER_QEMU_SYSROOT:-/home/node/.printstream-slicer/x86root}"

export HOME="${HOME:-/tmp/printstream-bambustudio-home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}"
# Force X11 + software GL so the offscreen GL used for plate thumbnails inits under Xvfb.
export GDK_BACKEND="${GDK_BACKEND:-x11}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
export GALLIUM_DRIVER="${GALLIUM_DRIVER:-llvmpipe}"
# Load the x86-64 Mesa DRI/llvmpipe drivers from the sysroot, not the host's arm64 ones.
export LIBGL_DRIVERS_PATH="${LIBGL_DRIVERS_PATH:-$sysroot/usr/lib/x86_64-linux-gnu/dri}"
unset WAYLAND_DISPLAY 2>/dev/null || true

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"

# Generated machine/process/filament presets live at <target>/profiles/*.
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

# qemu-user emulation: x86-64 loader/libs from the sysroot, the AppImage's bundled libs from bin/.
export QEMU_LD_PREFIX="$sysroot"
export LD_LIBRARY_PATH="$appdir/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LC_ALL=C
qemu="${SLICER_QEMU_BIN:-qemu-x86_64-static}"
bin="$appdir/bin/bambu-studio"

if command -v xvfb-run >/dev/null 2>&1; then
  # Xvfb + GLX so the offscreen GL context can be created for thumbnails.
  exec xvfb-run -a -s "-screen 0 1280x1024x24 +extension GLX +render -nolisten tcp" "$qemu" "$bin" "$@"
fi

exec "$qemu" "$bin" "$@"
