# Operations: backup, restore, monitoring, incidents

Operational runbook for **self-hosted** PrintStream — the Docker Compose stack. (Cloud-specific procedures live in the
maintainer's internal operations notes.)

The Postgres database holds all workspace, printer, job, and auth data;
the library volume holds uploaded model/gcode files. **Both must be backed up** —
a model file's bytes are not reconstructible from the database alone.

## What to back up

### Docker Compose stack

| Volume | Holds | Backup priority |
| --- | --- | --- |
| `printstream-postgres-data` | The entire application database | Critical — covered by the built-in server backups (below) |
| `printstream-data` | Library files, plugins, bridge release artifacts, snapshots | Critical (model bytes) — covered by the built-in server backups (below) |
| `printstream-bridge-data` | A bundled bridge's identity + library files | Important — covered automatically by the built-in bridge backups (below) |

## Server backups (built in — use these first)

The app backs itself up: with `BACKUPS_DIR` set (the compose example bind-mounts
a host `./backups` directory), it takes a whole-install backup on a schedule
(`BACKUP_INTERVAL_HOURS`, default daily; `0` = manual-only) and from
Settings → Backups ("Back up now"). Each backup is one directory:

- `db.dump` — a `pg_dump -Fc` of the entire database (all workspaces, printers,
  jobs, auth, settings, and every plugin's tables), verified with
  `pg_restore --list` before the backup is declared complete.
- `data/` — the persistent file tree (library, plugins, job-history snapshots
  and thumbnails, state files), with regenerable caches excluded. Unchanged
  files are hardlinked between snapshots, so a daily backup costs only the
  delta and deleting any snapshot never breaks another.
- `manifest.json` — app build, Postgres version, and the applied-migration set,
  which is how restore refuses a backup taken by a newer version.

Retention is automatic (7 daily, then 4 weekly, then 12 monthly); manual and
pre-restore backups are kept until deleted. A failed scheduled backup raises a
notification through the configured channels. Same-disk backups do not protect
against disk loss — sync the backups directory off-host with any tool (the
artifacts are plain files).

**Restore (from Settings → Backups).** Restoring replaces the whole install
with the chosen backup. The app first takes a `pre-restore` safety backup, then
restarts; on the way up — before anything opens the database — it recreates the
database from the dump, replaces the data tree, runs migrations forward, and
serves normally. Expect a short outage; the readiness probe stays red until the
restore completes. A backup taken by a newer app version or a newer Postgres
major is refused up front.

## Manual backup (disaster path / off-host copies)

The built-in system covers routine protection; these commands remain for
scripted off-host copies and for disasters where the app itself cannot run.

**Database:**

```sh
# Docker Compose
docker compose exec -T db pg_dump -U postgres -Fc printstream > printstream-$(date +%F).dump
```

**Library / data volume:**

```sh
docker run --rm -v printstream-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/printstream-data-$(date +%F).tgz -C /data .
```

**Native build.** Stop the service, then archive the data dir (or use a
filesystem/volume snapshot). Stopping ensures the embedded Postgres is quiesced;
a hot copy of a running cluster's data dir is not crash-consistent — prefer
`pg_dump` against the running instance if you cannot stop it. (Current native
builds ship `pg_dump`/`pg_restore` and use the built-in system; a build from
before they were bundled reports backups unavailable — update it, or point
`PG_DUMP_PATH`/`PG_RESTORE_PATH` at an installed PostgreSQL of the same major.)

**Always back up before an upgrade.** Migrations run forward on start and are not
auto-reverted; a pre-upgrade dump is your rollback.

## Bridge backups (built in)

The bridge backs itself up: with `BRIDGE_BACKUP_DIR` set (the compose examples
mount a host `./backups` directory), it snapshots its identity
file (`bridge-state.json`) and every library file on a schedule
(`BRIDGE_BACKUP_INTERVAL_HOURS`, default daily; `0` = manual-only), and you can
run one any time from Settings → Bridges → Manage → "Back up now".

- Each snapshot is a complete, restorable directory:
  `backup-<timestamp>/{manifest.json, bridge-state.json, library/...}`.
  Unchanged files are hardlinked between snapshots, so a snapshot costs only
  the delta; deleting any snapshot never breaks another.
- Retention is automatic: everything kept 7 days, then one per week for
  4 weeks, then one per month for 12 months.
- The backup directory is deliberately **outside** the bridge's data volume so
  wiping/recreating the app cannot take the backups with it. Same-disk backups
  do not protect against disk loss — point `BRIDGE_BACKUP_DIR` at another disk,
  or sync the directory off-host with any tool (the snapshots are plain files).
- Snapshots contain the bridge's runtime token (`bridge-state.json`); treat the
  backup directory as sensitive (it is created `0700`).

**Restoring a bridge from a snapshot** (dead disk, corrupted volume, or a
`bridge-state.json.corrupt` error):

```sh
docker compose stop bridge   # or stop the whole bridge stack / native service
# Copy the newest snapshot's contents back into the bridge data volume:
#   bridge-state.json -> /data/bridge-state.json
#   library/*         -> /data/library/
docker compose start bridge
```

The restored bridge re-registers with its preserved `installationId`, and the
server re-binds it to its existing record — printers, pairing, and library
intact, no re-pairing needed. Library metadata (names, folders, versions) lives
in the server database, so restore the newest snapshot even if it is newer than
a server backup you also restored; files the database doesn't reference are
simply ignored.

## Manual restore (drill this before you need it)

Docker Compose:

```sh
docker compose down                       # stop the app (keep volumes)
docker compose up -d db                    # bring up only Postgres
# Recreate the database from the dump:
docker compose exec -T db dropdb -U postgres --if-exists printstream
docker compose exec -T db createdb -U postgres printstream
docker compose exec -T db pg_restore -U postgres -d printstream < printstream-YYYY-MM-DD.dump
# Restore the library volume from the matching archive, then:
docker compose up -d
```

On startup the API runs migrations forward to the deployed schema. Restore the
library archive from the **same date** as the DB dump so file references resolve.
Verify with the readiness probe (below) and a spot-check of the Library and a
printer's history.

## Monitoring & alerting

- **Liveness:** `GET /api/health` (the process is up).
- **Readiness:** `GET /api/health/ready` — a DB-aware `SELECT 1`; returns 503
  when the database is unreachable. Point your orchestrator/load-balancer probe
  and uptime monitor here, not at `/api/health`.
- **Metrics:** opt-in Prometheus metrics + an example Grafana stack are in
  `docs/observability.md` (`METRICS_ENABLED`). Good things to alert on: readiness
  failing, `printstream_print_dispatch_duration{outcome="failed"}` rate, slice
  failure rate, `printstream_bridges_connected` dropping to 0, and event-loop lag.
- **Correlation IDs:** every request carries an `X-Request-Id` (echoed in error
  bodies and stamped on logs) so a user-reported failure maps to server logs.

## Incident quick-triage

1. **Is it up and ready?** `curl -fsS http://<host>/api/health/ready`. A 503 means
   the DB is unreachable — check the `db` container/cluster and disk space.
2. **Logs:** `docker compose logs --tail=200 api`.
   Grab the `requestId` from the user's error and grep for it.
3. **Bridge offline / printers not updating:** check `printstream_bridges_connected`
   and the bridge container logs; a bridge reconnects on its own once its link is
   restored.
4. **Disk full:** the library volume and Postgres share the host; scheduled
   cleanup prunes transient/recycled files, but a full disk wedges writes — free
   space, then restart.
5. **Bad deploy / migration:** roll back to the previous image tag and restore the
   pre-upgrade DB dump if a migration changed the schema destructively.
