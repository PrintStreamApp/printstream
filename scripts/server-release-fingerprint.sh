#!/usr/bin/env bash
# Content-addressed identity of a publishable self-hosted server build.
#
# Hashes every source that shapes the native server binary — the server entry
# and its SEA build script (whose pinned Node / PostgreSQL / engine versions
# change the shipped artifact), the API, the web app, the shared packages, and
# the in-box bridge runtime that gets bundled in — so two checkouts produce the
# same fingerprint iff they would build the same binary. The release workflow
# tags each GitHub Release `server-<fp12>` and skips the build when that release
# already exists; there is no semver version (content-addressed, like the bridge).
#
# Test files, demo entrypoints, and any `private/` material (absent in the public
# build) are excluded because they never ship in the artifact.
set -euo pipefail
cd "$(dirname "$0")/.."

find \
  apps/server/src \
  apps/server/scripts \
  apps/api/src \
  apps/api/prisma/schema.prisma \
  apps/api/prisma/migrations \
  apps/api/prisma/baseline.sql \
  apps/web/src \
  apps/web/index.html \
  apps/web/vite.config.ts \
  apps/bridge/src \
  packages/sea-runtime/src \
  packages/shared/src \
  packages/bridge-runtime/src \
  tsconfig.base.json \
  package-lock.json \
  -type f \
  ! -path '*/private/*' \
  ! -path 'apps/bridge/src/demo-*' \
  ! -name '*.test.ts' \
  ! -name '*.test.tsx' \
  ! -name '*.test.mjs' \
  -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
