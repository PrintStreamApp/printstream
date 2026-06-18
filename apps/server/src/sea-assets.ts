/**
 * Runtime extraction of the assets embedded in the packaged (SEA) executable.
 *
 * A single-file build has no `node_modules`, but Prisma's client resolves its
 * native query engine by path and cannot be bundled into the JS blob. So the
 * build embeds the generated Prisma client (`@prisma/client` + `.prisma/client`,
 * engine included) and the web bundle as zip **assets**; on first run we extract
 * them to the data dir and make the Prisma client resolvable by adding the
 * extracted `node_modules` to `NODE_PATH` (then re-initialising the module search
 * paths). The bundle's `require('@prisma/client')` then resolves to the extracted
 * copy, exactly as it does from a normal install.
 *
 * No-op when not packaged (dev runs from a real `node_modules`).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import yauzl from 'yauzl'
import type { ServerPaths } from './app-identity.js'
import { getSeaAssetBuffer, getSeaAssetByteLength, isSeaPackaged } from './packaged.js'

/** Installed by the SEA build banner to redirect external `require` to disk. */
type DiskRequireGlobal = { __setDiskRequireBase?: (base: string) => void }

/** Asset keys embedded by `scripts/build-sea.mjs`. */
const PRISMA_CLIENT_ASSET = 'prisma-client.zip'
const WEB_ASSET = 'web.zip'
const POSTGRES_ASSET = 'postgres.zip'
const MIGRATIONS_ASSET = 'migrations.zip'

/**
 * A signature of the embedded assets, used to detect that the running binary
 * differs from the one that last extracted into the data dir — so an upgrade
 * never keeps serving a stale web bundle / Prisma engine / migrations. The
 * assets are content-hashed at build time, so their byte lengths change with
 * any content change; concatenating them is a cheap, collision-safe-enough id.
 */
function embeddedAssetSignature(): string {
  return [PRISMA_CLIENT_ASSET, WEB_ASSET, POSTGRES_ASSET, MIGRATIONS_ASSET]
    .map((key) => getSeaAssetByteLength(key) ?? 0)
    .join('-')
}

/**
 * Extracts embedded assets and wires up Prisma resolution. Must run before the
 * API is imported, since the API loads the Prisma client at module init.
 *
 * Extraction is skipped only when the prior extraction came from the *same*
 * binary (matching {@link embeddedAssetSignature}); a new binary re-extracts
 * from scratch so an in-place upgrade over a kept data dir never serves stale
 * extracted assets. The DB cluster and library live elsewhere under the data
 * dir and are untouched.
 */
export async function prepareSeaRuntime(paths: ServerPaths): Promise<void> {
  if (!isSeaPackaged()) return

  const runtimeDir = path.join(paths.dataDir, 'runtime')
  const pgsqlDir = path.join(runtimeDir, 'pgsql')
  const migrationsDir = path.join(runtimeDir, 'migrations-data')
  const marker = path.join(runtimeDir, '.extracted')

  const signature = embeddedAssetSignature()
  const extracted = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null
  if (extracted !== signature) {
    // Replace any prior extraction wholesale so no stale file from an older
    // binary lingers (e.g. an old hashed web asset, or the pre-strip marketing
    // bundle). These dirs are pure extracted caches — safe to wipe and rebuild.
    rmSync(runtimeDir, { recursive: true, force: true })
    rmSync(paths.webDir, { recursive: true, force: true })

    mkdirSync(runtimeDir, { recursive: true })
    const prismaZip = getSeaAssetBuffer(PRISMA_CLIENT_ASSET)
    if (prismaZip) await extractZip(prismaZip, runtimeDir) // -> runtimeDir/node_modules/{@prisma,.prisma}
    const webZip = getSeaAssetBuffer(WEB_ASSET)
    if (webZip) {
      mkdirSync(paths.webDir, { recursive: true })
      await extractZip(webZip, paths.webDir)
    }
    const postgresZip = getSeaAssetBuffer(POSTGRES_ASSET)
    if (postgresZip) {
      await extractZip(postgresZip, pgsqlDir)
      recreatePostgresSymlinks(pgsqlDir) // npm can't pack the lib symlinks; rebuild them
    }
    const migrationsZip = getSeaAssetBuffer(MIGRATIONS_ASSET)
    if (migrationsZip) await extractZip(migrationsZip, migrationsDir)
    writeFileSync(marker, signature)
  }

  // Point the bundle's disk-require shim (installed by the SEA build banner) at
  // the extracted node_modules, so `require('@prisma/client')` resolves there.
  // The base is a notional file in `runtimeDir`; `node_modules` is its sibling.
  const setBase = (globalThis as DiskRequireGlobal).__setDiskRequireBase
  if (setBase) setBase(path.join(runtimeDir, 'index.js'))

  // Always (re)point resolution at the extracted assets — they exist whether we
  // just extracted them or are reusing a prior run. `??=` lets an operator override.
  process.env.EMBEDDED_POSTGRES_BIN_DIR ??= path.join(pgsqlDir, 'bin')
  process.env.PRINTSTREAM_MIGRATIONS_DIR ??= path.join(migrationsDir, 'migrations')
  process.env.PRINTSTREAM_BASELINE_SQL ??= path.join(migrationsDir, 'baseline.sql')
}

/**
 * Recreates the PostgreSQL shared-library symlinks (libpq, ICU, ...) that npm
 * cannot include in a package tarball. The `@embedded-postgres/<platform>`
 * package ships a `pg-symlinks.json` manifest for exactly this; entries use
 * paths rooted at `native/`, which map to the extraction dir.
 */
function recreatePostgresSymlinks(pgsqlDir: string): void {
  const manifestPath = path.join(pgsqlDir, 'pg-symlinks.json')
  if (!existsSync(manifestPath)) return
  const entries = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<{ source: string; target: string }>
  for (const { source, target } of entries) {
    const sourcePath = path.join(pgsqlDir, source.replace(/^native\//, ''))
    const targetPath = path.join(pgsqlDir, target.replace(/^native\//, ''))
    try {
      rmSync(targetPath, { force: true })
      symlinkSync(path.relative(path.dirname(targetPath), sourcePath), targetPath)
    } catch {
      // Best-effort; a missing symlink only matters if Postgres actually needs it.
    }
  }
}

/** Extracts a zip buffer into `destDir`, preserving the entry tree. */
function extractZip(zipBuffer: Buffer, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Could not open embedded zip asset.'))
        return
      }
      zip.on('entry', (entry: yauzl.Entry) => {
        const outPath = path.join(destDir, entry.fileName)
        if (entry.fileName.endsWith('/')) {
          mkdirSync(outPath, { recursive: true })
          zip.readEntry()
          return
        }
        mkdirSync(path.dirname(outPath), { recursive: true })
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('Could not read embedded zip entry.'))
            return
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0o777
          const out = createWriteStream(outPath, { mode: mode || 0o644 })
          stream.pipe(out)
          out.on('close', () => zip.readEntry())
          out.on('error', reject)
        })
      })
      zip.on('end', resolve)
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}
