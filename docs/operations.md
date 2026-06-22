# Operations: backup, restore, monitoring, incidents

Operational runbook for **self-hosted** PrintStream — the Docker Compose stack
and the native single-file build. (Cloud-specific procedures live in the
maintainer's internal operations notes.)

The embedded/Compose Postgres holds all workspace, printer, job, and auth data;
the library volume holds uploaded model/gcode files. **Both must be backed up** —
a model file's bytes are not reconstructible from the database alone.

## What to back up

### Docker Compose stack

| Volume | Holds | Backup priority |
| --- | --- | --- |
| `printstream-postgres-data` | The entire application database | Critical |
| `printstream-data` | Library files, plugins, bridge release artifacts, snapshots | Critical (model bytes) |
| `printstream-bridge-data` | A bundled bridge's identity + library files | Important |

### Native build

Everything lives under the data dir (default `/var/lib/printstream`, or
`PRINTSTREAM_DATA_DIR`): the embedded Postgres cluster (`db/`), the library, and
plugins. Back up the **whole data dir** (it is created `0700` and is as sensitive
as a credential — see `docs/native-self-hosted-packaging.md`).

## Backup

**Database (preferred: logical dump).** A `pg_dump` is portable across Postgres
versions and restores cleanly:

```sh
# Docker Compose
docker compose exec -T db pg_dump -U postgres -Fc printstream > printstream-$(date +%F).dump
```

Schedule it (cron/systemd timer) at a cadence matching your tolerance for data
loss (daily is a reasonable default), and copy the dump **off the host**. Keep a
rolling set (e.g. 7 daily + 4 weekly).

**Library / data volume.** Snapshot or archive the data volume alongside each DB
dump so the model bytes match the database state:

```sh
docker run --rm -v printstream-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/printstream-data-$(date +%F).tgz -C /data .
```

**Native build.** Stop the service, then archive the data dir (or use a
filesystem/volume snapshot). Stopping ensures the embedded Postgres is quiesced;
a hot copy of a running cluster's data dir is not crash-consistent — prefer
`pg_dump` against the running instance if you cannot stop it.

**Always back up before an upgrade.** Migrations run forward on start and are not
auto-reverted; a pre-upgrade dump is your rollback.

## Restore (drill this before you need it)

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
2. **Logs:** `docker compose logs --tail=200 api` (or the native service log).
   Grab the `requestId` from the user's error and grep for it.
3. **Bridge offline / printers not updating:** check `printstream_bridges_connected`
   and the bridge container logs; a bridge reconnects on its own once its link is
   restored.
4. **Disk full:** the library volume and Postgres share the host; scheduled
   cleanup prunes transient/recycled files, but a full disk wedges writes — free
   space, then restart.
5. **Bad deploy / migration:** roll back to the previous image tag and restore the
   pre-upgrade DB dump if a migration changed the schema destructively.
