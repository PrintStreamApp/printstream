#!/bin/bash
#
# SessionStart hook for Claude Code on the web.
#
# Makes a fresh, ephemeral container test-ready by reproducing what the
# devcontainer's postCreateCommand normally does:
#   1. install workspace dependencies
#   2. build the workspace packages that other apps import as built output
#      (@printstream/shared, @printstream/bridge-runtime)
#   3. stand up a local Postgres and sync the Prisma schema
#
# The project's baseline schema is established via `prisma db push` (the first
# migration is an AlterTable delta, not a from-scratch CREATE), so we push the
# schema rather than running `migrate deploy`.
#
# Safe to run multiple times (idempotent) and non-interactive.

set -euo pipefail

# Only do this in the remote (web) environment; local devs use the devcontainer.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --- Database connection (matches the devcontainer's DATABASE_URL) -----------
DB_URL="postgresql://postgres:postgres@localhost:5432/printstream?schema=public"
export DATABASE_URL="$DB_URL"
# Persist for the rest of the session so tests/CLI inherit it.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export DATABASE_URL=\"$DB_URL\"" >> "$CLAUDE_ENV_FILE"
fi

# --- 1. Install dependencies -------------------------------------------------
# `npm install` (not `ci`) so a cached node_modules can be reused incrementally.
npm install

# --- 2. Build workspace packages consumed as built dist/ output --------------
npm run build --workspace @printstream/shared
npm run build --workspace @printstream/bridge-runtime

# --- 3. Local Postgres -------------------------------------------------------
# Postgres refuses to run as root, so the cluster is owned by the unprivileged
# `postgres` system user.
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
PGDATA=/tmp/pgdata
PGRUN=/tmp/pgrun

if [ -n "$PGBIN" ]; then
  mkdir -p "$PGDATA" "$PGRUN"
  chown -R postgres:postgres "$PGDATA" "$PGRUN"

  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust"
  fi

  if ! su postgres -c "$PGBIN/pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/pg.log -w \
      -o '-p 5432 -k $PGRUN -c listen_addresses=localhost' start"
  fi

  # Wait until the server accepts connections.
  for _ in $(seq 1 30); do
    if su postgres -c "$PGBIN/pg_isready -h localhost -p 5432" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  # Create the application database if it does not already exist.
  if ! su postgres -c "$PGBIN/psql -h localhost -p 5432 -U postgres -tAc \
      \"SELECT 1 FROM pg_database WHERE datname='printstream'\"" | grep -q 1; then
    su postgres -c "$PGBIN/psql -h localhost -p 5432 -U postgres \
      -c 'CREATE DATABASE printstream;'"
  fi

  # --- 4. Prisma client + schema -------------------------------------------
  # Generate the client and sync the schema (baseline via db push).
  npm run db:generate
  npm run prisma:db:push --workspace @printstream/api -- --skip-generate
fi

echo "session-start hook complete: deps installed, schema synced, Postgres ready."
