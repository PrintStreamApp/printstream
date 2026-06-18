/**
 * Identity and filesystem layout for the self-hosted PrintStream **server**
 * single-executable build.
 *
 * The per-OS *location* rules live in the generic `@printstream/sea-runtime`
 * package; this module pins the server's identity and composes its own data-dir
 * files (config, embedded database cluster, library, plugins, web bundle, status
 * socket) on top — the same pattern the cloud bridge uses for its own paths.
 */
import {
  currentPlatformContext,
  platformPath,
  resolveStandaloneDataDir,
  resolveStandaloneInstallDir,
  standaloneControlSocket,
  standaloneExeName,
  type StandaloneAppIdentity,
  type StandalonePlatformContext
} from '@printstream/sea-runtime'

/** The self-hosted server's identity for the generic layout/service helpers. */
export const SERVER_IDENTITY: StandaloneAppIdentity = {
  appId: 'printstream',
  displayName: 'PrintStream'
}

/** Service description and documentation URL pinned into the service definition. */
export const SERVER_SERVICE_DESCRIPTION = 'Runs the self-hosted PrintStream app (web + API + database).'
export const SERVER_DOCUMENTATION_URL = 'https://printstream.app'

/** Env var that pins the data dir in the service definition / overrides the default. */
export const SERVER_DATA_DIR_ENV = 'PRINTSTREAM_DATA_DIR'

export interface ServerPaths {
  /** Root for config, the database cluster, library, plugins, and the web bundle. */
  dataDir: string
  /** dotenv-format config read at startup (PORT, BYO DATABASE_URL, ...). */
  configFile: string
  /** Embedded PostgreSQL cluster directory. */
  dbDir: string
  libraryDir: string
  pluginsDir: string
  bridgeReleasesDir: string
  /** Extracted web bundle the API serves (SEA asset in packaged builds). */
  webDir: string
  logsDir: string
  /** Where `service install` copies the executable. */
  installDir: string
  exeName: string
  /** Control channel endpoint: a Windows named pipe or a Unix socket file. */
  controlSocket: string
  /** World-readable JSON status snapshot for an unelevated `status`/tray reader. */
  statusFile: string
}

/** Resolves the server layout, honoring an explicit data-dir override first. */
export function resolveServerPaths(context: StandalonePlatformContext = currentPlatformContext()): ServerPaths {
  const join = platformPath(context.platform).join
  const dataDir = context.env[SERVER_DATA_DIR_ENV] ?? resolveStandaloneDataDir(context, SERVER_IDENTITY)
  return {
    dataDir,
    configFile: join(dataDir, 'server.env'),
    dbDir: join(dataDir, 'db'),
    libraryDir: join(dataDir, 'library'),
    pluginsDir: join(dataDir, 'plugins'),
    bridgeReleasesDir: join(dataDir, 'bridge-releases'),
    webDir: join(dataDir, 'web'),
    logsDir: join(dataDir, 'logs'),
    installDir: resolveStandaloneInstallDir(context, SERVER_IDENTITY),
    exeName: standaloneExeName(SERVER_IDENTITY, context.platform),
    controlSocket: standaloneControlSocket(SERVER_IDENTITY, context.platform, dataDir),
    statusFile: join(dataDir, 'status.json')
  }
}

/**
 * The status file at the **service's** (privileged) data dir. The running
 * service writes the world-readable status snapshot there; an unelevated reader
 * — the tray and `setup`/`status` run as the desktop user — must look at that
 * privileged location, not its own per-user data dir (which differs on Linux).
 * On Windows both resolve to the same machine-wide ProgramData.
 */
export function resolveServerServiceStatusFile(): string {
  return resolveServerPaths({ ...currentPlatformContext(), isPrivileged: true }).statusFile
}

/**
 * The **service's** (privileged) log directory — where WinSW/systemd write the
 * service's stdout/stderr. The tray's "View logs" item opens it, so it must
 * point at the service's location (which differs from a per-user run on Linux),
 * exactly like {@link resolveServerServiceStatusFile}.
 */
export function resolveServerServiceLogsDir(): string {
  return resolveServerPaths({ ...currentPlatformContext(), isPrivileged: true }).logsDir
}
