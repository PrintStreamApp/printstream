/**
 * Resolution of the Postgres client tools (`pg_dump` / `pg_restore`) the
 * server backup system shells out to.
 *
 * Contract: `resolvePgTools()` never throws, it reports either both tool
 * paths or a human-readable reason backups are unavailable on this build, so
 * the settings UI can say WHY instead of failing at run time. The probe result
 * is cached for the process lifetime (tools do not appear mid-run).
 *
 * Resolution order per tool: explicit env override (`PG_DUMP_PATH` /
 * `PG_RESTORE_PATH`) → the native build's embedded Postgres bin dir
 * (`EMBEDDED_POSTGRES_BIN_DIR`; today that dir ships only initdb/pg_ctl/
 * postgres, so native installs resolve nothing there until the packaging
 * grows the client tools) → bare name on PATH (the Docker image apt-installs
 * a matching postgresql-client).
 */
import path from 'node:path'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { env } from './env.js'

/**
 * Prisma-only `DATABASE_URL` query parameters that libpq (pg_dump/pg_restore,
 * and psql-style URIs generally) rejects as invalid. Prisma's own URL format
 * layers these on top of the libpq URI; anything not listed here passes
 * through untouched (sslmode, application_name, ... are real libpq params).
 */
const PRISMA_ONLY_URL_PARAMS = [
  'schema',
  'connection_limit',
  'pool_timeout',
  'pgbouncer',
  'socket_timeout',
  'statement_cache_size',
  'sslaccept',
  'sslidentity',
  'sslpassword'
]

/** A `DATABASE_URL` the Postgres client tools accept: Prisma-only params stripped. */
export function libpqCompatibleUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl)
    for (const param of PRISMA_ONLY_URL_PARAMS) {
      url.searchParams.delete(param)
    }
    return url.toString()
  } catch {
    return databaseUrl
  }
}

export type PgToolsResolution =
  | { available: true; pgDump: string; pgRestore: string; version: string }
  | { available: false; unavailableReason: string }

let cached: Promise<PgToolsResolution> | null = null

export function resolvePgTools(): Promise<PgToolsResolution> {
  cached ??= probePgTools()
  return cached
}

/** Test hook: forget the cached probe so tests can vary the environment. */
export function resetPgToolsCacheForTests(): void {
  cached = null
}

async function probePgTools(): Promise<PgToolsResolution> {
  const pgDump = await resolveTool('pg_dump', env.PG_DUMP_PATH)
  const pgRestore = await resolveTool('pg_restore', env.PG_RESTORE_PATH)
  if (!pgDump || !pgRestore) {
    const missing = [!pgDump ? 'pg_dump' : null, !pgRestore ? 'pg_restore' : null].filter(Boolean).join(' and ')
    return {
      available: false,
      unavailableReason: `The Postgres client tools (${missing}) are not available on this install, so built-in backups cannot run.`
    }
  }
  const version = await toolVersion(pgDump)
  if (!version) {
    return {
      available: false,
      unavailableReason: `${pgDump} did not answer --version; built-in backups cannot run.`
    }
  }
  return { available: true, pgDump, pgRestore, version }
}

async function resolveTool(name: string, override: string | undefined): Promise<string | null> {
  if (override) {
    return (await isExecutableFile(override)) ? override : null
  }
  const embeddedBinDir = process.env.EMBEDDED_POSTGRES_BIN_DIR
  if (embeddedBinDir) {
    const exeName = process.platform === 'win32' ? `${name}.exe` : name
    const candidate = path.join(embeddedBinDir, exeName)
    if (await isExecutableFile(candidate)) return candidate
  }
  // Bare name: let the OS search PATH; verified by actually running it.
  return (await toolVersion(name)) ? name : null
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function toolVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    let output = ''
    let child
    try {
      child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? output.trim() || null : null))
  })
}

/**
 * Runs a Postgres client tool to completion, capturing stderr for the error
 * message. Throws with the tool's own complaint on a non-zero exit, a failed
 * dump's stderr is the diagnosis, never to be swallowed.
 */
export function runPgTool(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep the tail: pg_restore --list on a big archive can chatter, and the
      // failure reason is at the end.
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', (error) => reject(new Error(`${path.basename(command)} failed to start: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.trim() || 'no error output'}`))
    })
  })
}
