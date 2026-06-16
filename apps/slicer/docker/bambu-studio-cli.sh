#!/bin/sh
set -eu

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

if command -v xvfb-run >/dev/null 2>&1; then
  # Start Xvfb with GLX so the offscreen GL context can be created for thumbnails.
  exec xvfb-run -a -s "-screen 0 1280x1024x24 +extension GLX +render -nolisten tcp" "$appdir/AppRun" "$@"
fi

exec "$appdir/AppRun" "$@"