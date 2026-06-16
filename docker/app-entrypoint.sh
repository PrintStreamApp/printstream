#!/bin/sh
# Dispatches the combined PrintStream app image to a role:
#   (default) / "api"  -> apply DB migrations, then run the API (which serves the
#                         web SPA + /api + /ws on one port via SERVE_WEB_DIR)
#   "bridge"           -> run the LAN bridge (launcher)
#   anything else      -> exec'd verbatim (e.g. the demo bootstrap command)
# One image builds web + API + bridge; the cloud build and the published
# open-core image are identical (no divergence). PostgreSQL is the `db` service.
set -e

case "${1:-api}" in
  api)
    node scripts/bootstrap-prisma-migrations.mjs
    exec node apps/api/dist/index.js
    ;;
  bridge)
    exec node apps/bridge/dist/launcher.js
    ;;
  *)
    exec "$@"
    ;;
esac
