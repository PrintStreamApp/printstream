#!/bin/bash
set -euo pipefail

# Fix ownership of persisted named-volume mounts so the non-root remote user
# can write to them.
#
# Why this is needed: when Docker mounts a *fresh* named volume over a path
# that doesn't already exist (with the right ownership) in the image, it
# creates the mountpoint as root:root. The non-root user then can't write
# there — surfacing as "permission denied" the first time a tool (gh,
# npm, …) writes into ~/.config, /commandhistory, and friends.
#
# This is a drop-in, project-agnostic safety net: it auto-discovers every
# mount under the given roots and chowns any whose top-level owner is wrong.
# Idempotent — once a volume is correctly owned it's skipped on every later
# run, so it's cheap to invoke from postCreateCommand on every (re)build.
#
# Usage: fix-volume-perms.sh [ROOT ...]
#   ROOT defaults to the remote user's home plus /commandhistory.

# Derive the target user from the identity we're actually running as (the
# remote user during postCreate). REMOTE_USER can override. `id -un` is more
# reliable than $USER, which is often unset in postCreate.
USER_NAME="${REMOTE_USER:-$(id -un)}"
# getent isn't present on every base image (e.g. Alpine/musl); fall back to
# $HOME (set to the running user's home) and finally a conventional path.
USER_HOME="$(getent passwd "$USER_NAME" 2>/dev/null | cut -d: -f6 || true)"
USER_HOME="${USER_HOME:-${HOME:-/home/$USER_NAME}}"

# Use sudo only when we're not already root. Root containers (e.g. the
# Alpine-based images) own fresh volumes correctly already and may not even
# have sudo installed, so calling it unconditionally would break them.
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# Roots to scan for volume mounts. Pass extras as args for any project that
# persists volumes outside these locations.
ROOTS=("$@")
if [ ${#ROOTS[@]} -eq 0 ]; then
    ROOTS=("$USER_HOME" /commandhistory)
fi

is_under_root() {
    local path="$1" root
    for root in "${ROOTS[@]}"; do
        [ "$path" = "$root" ] && return 0
        case "$path" in "$root"/*) return 0 ;; esac
    done
    return 1
}

# Field 2 of /proc/mounts is the mountpoint; field 4 is the mount options.
# Skip read-only mounts (e.g. ~/.ssh:ro) — we can't and shouldn't chown those.
while read -r _ mountpoint _ options _; do
    case ",$options," in *,ro,*) continue ;; esac
    is_under_root "$mountpoint" || continue
    [ -e "$mountpoint" ] || continue

    owner="$(stat -c '%U' "$mountpoint" 2>/dev/null || true)"
    if [ "$owner" != "$USER_NAME" ]; then
        echo "fix-volume-perms: $mountpoint owned by '${owner:-?}' -> $USER_NAME"
        # Recursive only triggers when the top-level owner is wrong, so a
        # correctly-owned volume is never re-walked. Fresh volumes are empty
        # (instant); a previously-broken volume gets fully repaired once.
        $SUDO chown -R "$USER_NAME:$USER_NAME" "$mountpoint"
    fi
done < /proc/mounts
