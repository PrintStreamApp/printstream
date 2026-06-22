/**
 * Embedded PostgreSQL supervisor for the native single-file (SEA) self-hosted
 * build, so a self-hoster can run the whole app with no database to operate.
 *
 * When `EMBEDDED_POSTGRES` is enabled this brings up a per-install Postgres
 * cluster under a local data directory (portable binaries shipped by the
 * `embedded-postgres` package, which has a real `linux-arm64` build for the
 * Raspberry Pi target) and hands back the `DATABASE_URL` the rest of the app
 * connects through. When it is disabled (the default — the Docker and cloud
 * deployments, which connect to an operator-managed external database) this is a
 * no-op and the operator-provided `DATABASE_URL` is used unchanged. The native
 * single-file build always enables it (it has no external-database option).
 *
 * ## Transport (no port to collide with)
 *
 * On Linux/macOS the cluster listens on a **Unix domain socket only** (no TCP
 * port at all), so it can never clash with another application's port. On Windows
 * — where Postgres/Prisma Unix-socket support is unreliable — it binds a
 * **loopback TCP port chosen free at startup**, which likewise cannot collide.
 * Setting `EMBEDDED_POSTGRES_PORT` overrides both with a fixed loopback TCP port.
 *
 * ## Ordering boundary (why this reads `process.env` directly)
 *
 * The Prisma client captures `DATABASE_URL` from the env module the moment it is
 * constructed, and the env module parses `process.env` the first time it is
 * imported. So the embedded cluster must be started — and `process.env.DATABASE_URL`
 * rewritten to point at it — *before* the env module (and therefore Prisma) is
 * imported. That makes this supervisor a deliberate **pre-env** boundary: the
 * `server.ts` entrypoint calls it before importing the app, and it reads its own
 * handful of settings from `process.env` rather than from the env module it must
 * precede. This is the one place outside `env.ts` that reads `process.env`.
 *
 * A single-instance guard via Postgres' own `postmaster.pid` keeps two app
 * instances from opening one data dir; Postgres is crash-safe, so an abrupt stop
 * of a `persistent` cluster only costs a recovery on next start.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
// Type-only at module load: `embedded-postgres` resolves its platform binary
// package (`@embedded-postgres/<platform>`) eagerly at *import* time, which fails
// in a SEA bundle (no node_modules) and is wasted work when embedded mode is off.
// The value is dynamically imported inside `startEmbeddedPostgresIfEnabled` only
// when embedded mode is actually enabled.
import type EmbeddedPostgres from 'embedded-postgres'

/** Database created inside the embedded cluster for the app to use. */
const EMBEDDED_DATABASE_NAME = 'printstream'
/** Superuser for the local-only cluster. */
const EMBEDDED_USER = 'postgres'
/**
 * Superuser password. The cluster is reachable only over a private socket (or a
 * loopback port) and its data directory is already as sensitive as this
 * credential, so a stable local password (not a real secret) keeps restarts
 * idempotent — initdb sets it once and every later boot presents the same value.
 */
const EMBEDDED_PASSWORD = 'postgres'
const DEFAULT_DATA_DIR = './data/postgres'
/** Port number for the Unix-socket filename (`.s.PGSQL.<n>`); not a TCP bind. */
const SOCKET_PORT = 5432

/** A running embedded cluster and how to connect to / stop it. */
export interface EmbeddedDatabase {
  /** Connection string for the app database inside the cluster. */
  databaseUrl: string
  /** Stops the cluster (data is left in place; `persistent` is on). */
  stop(): Promise<void>
}

interface EmbeddedConfig {
  enabled: boolean
  dataDir: string
  /** Fixed loopback TCP port from `EMBEDDED_POSTGRES_PORT`, or null to auto-pick the transport. */
  explicitPort: number | null
}

/** Reads the supervisor's settings from `process.env` (see the ordering note). */
function readEmbeddedConfig(): EmbeddedConfig {
  const flag = (process.env.EMBEDDED_POSTGRES ?? '').trim().toLowerCase()
  const enabled = flag === '1' || flag === 'true'
  const dataDir = (process.env.EMBEDDED_POSTGRES_DATA_DIR ?? '').trim() || DEFAULT_DATA_DIR
  const portRaw = (process.env.EMBEDDED_POSTGRES_PORT ?? '').trim()
  const explicitPort = portRaw.length > 0 && Number.isInteger(Number(portRaw)) && Number(portRaw) > 0 ? Number(portRaw) : null
  return { enabled, dataDir, explicitPort }
}

/** Binds port 0 on loopback to let the OS hand back a guaranteed-free port. */
function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('Could not find a free port.'))))
    })
  })
}

/**
 * Throws a clear error if another process is already running a cluster on this
 * data directory. Postgres' own `postmaster.pid` is the source of truth (its
 * first line is the postmaster PID); a stale file left by a crash is ignored —
 * Postgres cleans it up itself on the next start.
 */
function assertNoLiveCluster(dataDir: string): void {
  const pidFile = path.join(dataDir, 'postmaster.pid')
  if (!existsSync(pidFile)) return
  const firstLine = readFileSync(pidFile, 'utf8').split('\n', 1)[0]?.trim()
  const pid = Number(firstLine)
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, 0) // throws ESRCH if the process is gone
  } catch {
    return // stale lock; let Postgres reclaim it
  }
  throw new Error(
    `An embedded PostgreSQL instance (pid ${pid}) is already running on ${dataDir}. ` +
      'Only one app instance may own a data directory at a time.'
  )
}

/**
 * Creates the app database inside the freshly-started cluster if it is absent,
 * over the given host (a socket dir or loopback). We issue `CREATE DATABASE`
 * ourselves rather than via `postgres.createDatabase()`, whose client defaults
 * to a localhost TCP connection that does not exist in socket mode.
 */
async function ensureAppDatabase(postgres: EmbeddedPostgres, host: string): Promise<void> {
  const client = postgres.getPgClient('postgres', host)
  await client.connect()
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [EMBEDDED_DATABASE_NAME])
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(EMBEDDED_DATABASE_NAME)}`)
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

/**
 * Starts the embedded cluster when `EMBEDDED_POSTGRES` is enabled and returns its
 * connection handle; returns `null` when disabled (the caller then keeps the
 * operator-provided `DATABASE_URL`). Initialises the cluster on first run and
 * reuses it (and its data) on every subsequent boot.
 */
export async function startEmbeddedPostgresIfEnabled(
  log: (message: string) => void = () => undefined
): Promise<EmbeddedDatabase | null> {
  const config = readEmbeddedConfig()
  if (!config.enabled) return null

  const dataDir = path.resolve(config.dataDir)
  assertNoLiveCluster(dataDir)

  // Pick the transport: Unix socket (no TCP) on POSIX; a free loopback port on
  // Windows; a fixed loopback port when the operator pins one.
  const useSocket = config.explicitPort === null && process.platform !== 'win32'
  const port = config.explicitPort ?? (useSocket ? SOCKET_PORT : await findFreeLoopbackPort())
  const host = useSocket ? dataDir : '127.0.0.1'
  const postgresFlags = useSocket
    // 0700 socket perms: only the cluster's own service user can connect over the
    // Unix socket, so the well-known embedded superuser password is not reachable
    // by other local users on a shared host (defense-in-depth with the 0700 data
    // dir set in apps/server's ensureServerDirs).
    ? ['-c', 'listen_addresses=', '-c', `unix_socket_directories=${dataDir}`, '-c', 'unix_socket_permissions=0700']
    : ['-c', 'listen_addresses=127.0.0.1']

  // Imported here (not at module load) so the platform binary package is only
  // resolved when embedded mode is actually used. See the import note above.
  const { default: EmbeddedPostgresCtor } = await import('embedded-postgres')
  // embedded-postgres rejects `start()`/`initialise()` without a useful Error
  // (the real reason only reaches `onError`), so capture the last message and
  // rethrow it with context — otherwise startup failures surface as `undefined`.
  // Postgres' own diagnostics (e.g. "PostgreSQL by a user with administrative
  // permissions is not permitted") arrive on `onLog` as often as `onError`, so
  // track the last non-empty message from either channel to attach to a failure.
  let lastPostgresMessage = ''
  const remember = (message: unknown): void => {
    const text = String(message).trim()
    if (text) lastPostgresMessage = text
  }
  const postgres = new EmbeddedPostgresCtor({
    databaseDir: dataDir,
    port,
    user: EMBEDDED_USER,
    password: EMBEDDED_PASSWORD,
    authMethod: 'scram-sha-256',
    persistent: true,
    postgresFlags,
    onLog: (message) => {
      remember(message)
      log(message)
    },
    onError: (message) => {
      remember(message)
      console.error('[embedded-postgres]', message)
    }
  })
  const describeFailure = (verb: string, error: unknown): Error => {
    const detail = lastPostgresMessage || (error instanceof Error ? error.message : String(error))
    return new Error(`Embedded PostgreSQL failed to ${verb}: ${detail || 'unknown error'}`)
  }

  const alreadyInitialised = existsSync(path.join(dataDir, 'PG_VERSION'))
  if (!alreadyInitialised) {
    log(`Initialising embedded PostgreSQL cluster at ${dataDir}`)
    try {
      await postgres.initialise()
    } catch (error) {
      throw describeFailure('initialise', error)
    }
  }

  log(useSocket ? `Starting embedded PostgreSQL on a local socket in ${dataDir}` : `Starting embedded PostgreSQL on 127.0.0.1:${port}`)
  try {
    await postgres.start()
  } catch (error) {
    throw describeFailure('start', error)
  }
  await ensureAppDatabase(postgres, host)

  return {
    databaseUrl: useSocket
      ? `postgresql://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@localhost/${EMBEDDED_DATABASE_NAME}?host=${encodeURIComponent(dataDir)}`
      : `postgresql://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@127.0.0.1:${port}/${EMBEDDED_DATABASE_NAME}`,
    stop: () => postgres.stop()
  }
}
