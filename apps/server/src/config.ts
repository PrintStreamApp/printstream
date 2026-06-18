/**
 * Translates the server's data-dir layout + operator config file into the
 * environment the API boot (`@printstream/api/server`) reads. Operator-set values
 * (from `server.env` or the real environment) always win; this only fills in the
 * single-box defaults — embedded Postgres under the data dir, library/plugins
 * dirs, and the web bundle — when the operator has not set them.
 */
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfigFileValues } from '@printstream/sea-runtime'
import { isSeaPackaged } from './packaged.js'
import type { ServerPaths } from './app-identity.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** Default port the self-hosted app serves on (web + API + WS on one port). */
const DEFAULT_PORT = 8080

/** Loads `server.env` (dotenv) and applies it to `process.env` (without clobbering). */
export async function applyConfigFile(paths: ServerPaths): Promise<void> {
  const values = await readConfigFileValues(paths.configFile)
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/**
 * Fills in the single-box environment for the API boot. Must run before
 * `@printstream/api/server` is imported, since the API captures env at load.
 * Only sets a var when it is still unset, so an operator can override any of it
 * (e.g. set `EMBEDDED_POSTGRES=false` + `DATABASE_URL` to bring their own DB).
 */
export function applyServerEnvDefaults(paths: ServerPaths): void {
  setDefault('EMBEDDED_POSTGRES', 'true')
  setDefault('PRINTSTREAM_DATA_DIR', paths.dataDir)
  setDefault('EMBEDDED_POSTGRES_DATA_DIR', paths.dbDir)
  setDefault('LIBRARY_DIR', paths.libraryDir)
  setDefault('PLUGINS_DIR', paths.pluginsDir)
  setDefault('BRIDGE_RELEASES_DIR', paths.bridgeReleasesDir)
  setDefault('AUTO_CREATE_DEFAULT_WORKSPACE', 'true')
  setDefault('API_PORT', String(resolvePort()))
  if (isSeaPackaged()) setDefault('NODE_ENV', 'production')

  // Run the bundled in-box bridge by default so a single box has LAN access
  // without operating a separate bridge. The token file is shared by the API
  // (which issues it) and the in-box bridge (which presents it).
  setDefault('MANAGED_BRIDGE', 'true')
  setDefault('MANAGED_BRIDGE_TOKEN_FILE', path.join(paths.dataDir, 'managed-bridge-token'))

  const webDir = resolveWebDir(paths)
  if (webDir) setDefault('SERVE_WEB_DIR', webDir)
}

/** The port the app serves on (config `PORT`/`API_PORT` win; else the default). */
export function resolvePort(): number {
  const raw = (process.env.API_PORT ?? process.env.PORT ?? '').trim()
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT
}

/**
 * Locates the built web bundle to serve. Packaged builds extract it as a SEA
 * asset to `<dataDir>/web` (Phase 5); from source we fall back to the repo's
 * `apps/web/dist` so `run` serves the SPA in dev too. Returns undefined when no
 * bundle is available (the API still serves `/api` + `/ws` headlessly).
 */
function resolveWebDir(paths: ServerPaths): string | undefined {
  const configured = process.env.SERVE_WEB_DIR?.trim()
  if (configured) return configured
  if (isSeaPackaged() && existsSync(paths.webDir)) return paths.webDir
  // Dev / from-source: apps/server/dist|src/* -> repo apps/web/dist
  const repoWebDist = path.resolve(moduleDir, '..', '..', 'web', 'dist')
  if (existsSync(repoWebDist)) return repoWebDist
  return undefined
}

/** Creates the server's data subdirectories. */
export function ensureServerDirs(paths: ServerPaths): void {
  for (const dir of [paths.dataDir, paths.dbDir, paths.libraryDir, paths.pluginsDir, paths.bridgeReleasesDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true })
  }
}

function setDefault(key: string, value: string): void {
  if (process.env[key] === undefined) process.env[key] = value
}
