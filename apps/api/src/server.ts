/**
 * Process entry point (pre-env boot stage).
 *
 * This wrapper exists so the embedded database can be brought up and its
 * `DATABASE_URL` published into `process.env` *before* the env module — and the
 * Prisma client it configures — are first imported. It therefore statically
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
    // The CLI-free applier provisions a fresh cluster from the baseline snapshot
    // and forward-applies any new migrations — the Docker stack's CLI bootstrap
    // is not in this bundle. (Dynamic import so nothing DB-related loads before
    // the URL above is set.)
    const { applyPendingMigrations } = await import('./lib/apply-migrations.js')
    await applyPendingMigrations({
      databaseUrl: embedded.databaseUrl,
      log: (message) => console.log('[migrate]', message)
    })
  }

  await import('./index.js')
}

void main().catch((error) => {
  // Print a real reason, not `undefined`: some startup failures (e.g. the
  // embedded database) reject without an Error, with the detail logged above.
  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : error == null
        ? '(no error detail — see the logged output above for the underlying cause)'
        : String(error)
  console.error('Fatal error during startup:', detail)
  process.exit(1)
})
