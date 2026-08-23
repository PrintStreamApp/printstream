/**
 * Process entry point (pre-env boot stage).
 *
 * This wrapper exists so the embedded database can be brought up and its
 * `DATABASE_URL` published into `process.env` *before* the env module, and the
 * Prisma client it configures, are first imported. It therefore statically
 * imports only the embedded-postgres supervisor (which is careful not to import
 * the env module) and defers the real server to a dynamic `import('./index.js')`
 * once the database URL is settled. See `embedded-postgres.ts` for the ordering
 * rationale.
 *
 * When `EMBEDDED_POSTGRES` is disabled (the Docker and cloud deployments, which
 * connect to an external `DATABASE_URL`) this is a
 * thin pass-through to `index.ts` with no behavior change: migrations there are
 * still applied by the Docker entrypoint's CLI bootstrap before the process
 * starts. Only the embedded path applies migrations here, against the freshly
 * started local cluster, using the CLI-free applier.
 */
import { startEmbeddedPostgresIfEnabled } from './lib/embedded-postgres.js'

async function main(): Promise<void> {
  const embedded = await startEmbeddedPostgresIfEnabled((message) => console.log('[embedded-postgres]', message))

  if (embedded) {
    process.env.DATABASE_URL = embedded.databaseUrl
    // Stop the embedded cluster as part of graceful shutdown. Registered before
    // index.ts (and its signal handlers) loads, so a SIGTERM during startup can't
    // race past it. The registry is env-free, so importing it here is pre-env safe.
    const { registerShutdownHook } = await import('./lib/shutdown-hooks.js')
    registerShutdownHook(() => embedded.stop())
  }

  // A staged backup restore applies HERE: the one window where the database
  // URL is settled but neither Prisma nor migrations have touched the DB. A
  // no-op on every ordinary boot. (Dynamic import: the module reads the env
  // snapshot, which must not be taken before the URL above is published. On
  // the Docker path the entrypoint has already migrated the pre-restore
  // database; harmless, since a restore drops it.)
  const { applyStagedServerRestoreIfPending } = await import('./lib/server-backup-restore.js')
  const restored = await applyStagedServerRestoreIfPending()

  if (embedded || restored) {
    // The CLI-free applier provisions a fresh cluster from the baseline snapshot
    // and forward-applies any new migrations: the Docker stack's CLI bootstrap
    // is not in this bundle, and a freshly-restored database (either stack)
    // must be migrated forward to the installed schema before the app opens it.
    const { applyPendingMigrations } = await import('./lib/apply-migrations.js')
    await applyPendingMigrations({
      databaseUrl: embedded?.databaseUrl ?? restored!.databaseUrl,
      log: (message) => console.log('[migrate]', message)
    })
  }

  await import('./index.js')
}

/**
 * Resolves once the embedded database is up, migrated, and `index.ts` has
 * loaded -- i.e. once `DATABASE_URL` is published and safe to read.
 *
 * Exported because a HOST process needs to await the BOOT, not the module
 * evaluation. `void main()` on its own made `await import('@printstream/api/server')`
 * resolve immediately, so the native app's `run.ts` carried on and imported
 * API modules while `DATABASE_URL` was still the compose default -- which
 * constructs Prisma against `db:5432` and CACHES it for the life of the
 * process. The result was an app whose migrations ran against the embedded
 * socket while every query went to a host that does not exist, and which then
 * died on the first unhandled rejection.
 *
 * Nothing awaits this on the Docker/cloud path, where this file is the process
 * entry; the rejection handler below is what matters there.
 */
export const started: Promise<void> = main()

started.catch((error) => {
  // Print a real reason, not `undefined`: some startup failures (e.g. the
  // embedded database) reject without an Error, with the detail logged above.
  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : error == null
        ? '(no error detail: see the logged output above for the underlying cause)'
        : String(error)
  console.error('Fatal error during startup:', detail)
  process.exit(1)
})
