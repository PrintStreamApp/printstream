/**
 * Builds the self-hosted PrintStream server as a Node SEA (single-file
 * executable).
 *
 * Pipeline: esbuild-bundle `src/sea-entry.ts` to CJS (with an `import.meta.url`
 * shim, Prisma external, and embedded-postgres's binary resolver swapped for an
 * env-driven one); embed the generated Prisma client (engine pruned to the
 * target), the target's portable PostgreSQL, the migration SQL, and the web
 * bundle as zip assets; then hand off to the shared SEA harness
 * (`@printstream/sea-runtime/build`) for the Node download, blob generation,
 * postject injection, and Windows signing — the same harness the cloud
 * bridge uses. The runtime (`src/sea-assets.ts`) extracts the assets at startup.
 *
 * Usage: `node scripts/build-sea.mjs [--target <key>] [--node-version <v>]`
 * Targets: linux-x64, linux-arm64, win32-x64 (default: the build host).
 * Non-host targets' PostgreSQL is fetched on demand via npm pack, and their
 * artifacts can only be *run* on that OS/arch.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync,
  readdirSync, readFileSync, renameSync, rmSync, statSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yazl from 'yazl'
import {
  DEFAULT_NODE_VERSION,
  SEA_TARGETS,
  brandWindowsExecutable,
  downloadToFile,
  ensureNodeBinary,
  fail,
  fetchNodeShasums,
  generateSeaBlob,
  hostTargetKey,
  injectSeaBlob,
  stripWindowsAuthenticodeSignature
} from '@printstream/sea-runtime/build'
import { trayIconIcoBuffer } from '@printstream/sea-runtime'

/**
 * WinSW service wrapper, embedded (for win32 targets only) as the `winsw.exe`
 * SEA asset the service controller writes out at install time. Same pinned
 * binary the cloud bridge uses, so both single-file apps install identically.
 */
const WINSW = {
  url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe',
  sha256: 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f',
  cacheFileName: 'winsw-2.12.0-net461.exe'
}

/**
 * Server-specific per-target data: the Prisma query-engine file (from the
 * `binaryTargets` generator) and the `@embedded-postgres` package key. Node
 * download coordinates come from the shared harness `SEA_TARGETS`.
 *
 * No `win32-arm64`: unlike the bridge (whose only native dep is ffmpeg, borrowed
 * from x64), the server's heavy native deps have no Windows-ARM64 builds — Prisma
 * has no `windows-arm64` query engine (only `windows` = x64) and there is no
 * `@embedded-postgres/windows-arm64` package. A win32-arm64 build would emulate
 * both anyway, and the `win32-x64` artifact already runs on Windows 11 ARM64
 * under x64 emulation, so that is what ARM64 Windows users run.
 */
const SERVER_TARGETS = {
  'linux-x64': { engine: 'libquery_engine-debian-openssl-3.0.x.so.node', pgKey: 'linux-x64' },
  'linux-arm64': { engine: 'libquery_engine-linux-arm64-openssl-3.0.x.so.node', pgKey: 'linux-arm64' },
  'win32-x64': { engine: 'query_engine-windows.dll.node', pgKey: 'windows-x64' }
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(serverDir, '..', '..')
const nodeModules = path.join(repoRoot, 'node_modules')
const cacheDir = path.join(serverDir, '.cache', 'sea')

const args = parseArgs(process.argv.slice(2))
const targetKey = args.target ?? hostTargetKey()
const nodeVersion = args.nodeVersion ?? DEFAULT_NODE_VERSION
const serverTarget = SERVER_TARGETS[targetKey]
if (!serverTarget) fail(`Unknown target '${targetKey}'. Known: ${Object.keys(SERVER_TARGETS).join(', ')}`)
const exeSuffix = SEA_TARGETS[targetKey].exeSuffix

const workDir = path.join(serverDir, 'release', 'sea-work', targetKey)
const outDir = path.join(serverDir, 'release', 'sea')

async function main() {
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })

  console.log(`Building target ${targetKey} (Node ${nodeVersion})`)

  const bundlePath = path.join(workDir, 'server.cjs')
  await bundle(bundlePath)

  const assets = {
    'prisma-client.zip': await buildPrismaAsset(),
    'postgres.zip': await buildPostgresAsset(),
    'migrations.zip': await buildMigrationsAsset()
  }
  assets['web.zip'] = await zipDir(buildPublicWebDist(), path.join(workDir, 'web.zip'))
  // The Windows service is run by WinSW; embed its wrapper for win32 targets so
  // `service install` can write it out (the controller refuses without it).
  if (targetKey.startsWith('win32')) {
    assets['winsw.exe'] = await ensureWinsw()
  }

  // Generate the blob with a host Node of the pinned version, then inject it into
  // the downloaded target Node (shared harness; identical to the bridge).
  const shasums = await fetchNodeShasums(nodeVersion, cacheDir)
  const hostNode = await ensureNodeBinary(hostTargetKey(), nodeVersion, cacheDir, shasums)
  const blobPath = path.join(workDir, 'server.blob')
  await generateSeaBlob({ hostNode, main: bundlePath, output: blobPath, assets })

  const targetNode = await ensureNodeBinary(targetKey, nodeVersion, cacheDir, shasums)
  const artifactPath = path.join(outDir, `printstream-${targetKey}${exeSuffix}`)
  copyFileSync(targetNode, artifactPath)
  chmodSync(artifactPath, 0o755)

  // Strip the Windows signature *before* injection so re-signing succeeds, brand
  // the exe (icon + version → no "Node.js" in the UAC prompt), then inject the
  // blob last so its injection can never be disturbed by the resource rewrite.
  if (targetKey.startsWith('win32')) {
    await stripWindowsAuthenticodeSignature(artifactPath)
    await brandWindowsExecutable({
      artifactPath,
      icoBuffer: trayIconIcoBuffer(),
      productName: 'PrintStream',
      fileDescription: 'PrintStream — self-hosted 3D print manager',
      // GUI subsystem: double-click never flashes a console; setup runs entirely
      // through the setup window + tray. WinSW still captures the service's stdout
      // through a pipe, so service logging is unaffected.
      guiSubsystem: true
    })
  }
  await injectSeaBlob({ artifactPath, blobPath })

  const sizeMb = (statSync(artifactPath).size / 1024 / 1024).toFixed(0)
  console.log(`\nBuilt ${artifactPath} (${sizeMb} MB)`)
}

async function bundle(outfile) {
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [path.join(serverDir, 'src', 'sea-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    define: { 'import.meta.url': '__serverImportMetaUrl' },
    banner: {
      // The SEA's embedded require() only loads built-in modules, so the bundle's
      // require of the external Prisma client must go through a createRequire()
      // bound to the extracted node_modules. `__setDiskRequireBase` (called by
      // sea-assets.ts after extraction) points the shim there; until then (and in
      // dev) it falls back to the ambient require.
      js: [
        "const { createRequire: __createRequire } = require('node:module');",
        "var __serverImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
        'var __embedRequire = require;',
        'var __diskRequire = null;',
        'globalThis.__setDiskRequireBase = function (base) { __diskRequire = __createRequire(base); };',
        'require = function (id) { return (__diskRequire || __embedRequire)(id); };'
      ].join('\n')
    },
    // Prisma can't be bundled (native engine) — external, extracted at runtime.
    external: ['bufferutil', 'utf-8-validate', '@embedded-postgres/*', '@prisma/client', '.prisma/client'],
    plugins: [embeddedPostgresBinaryPlugin()],
    logLevel: 'info'
  })
}

/**
 * Replaces `embedded-postgres`'s binary resolver (which `import()`s a
 * `@embedded-postgres/<platform>` package from node_modules — impossible in a
 * SEA) with one that reads the extracted binary dir from `EMBEDDED_POSTGRES_BIN_DIR`.
 * All of embedded-postgres's lifecycle (initdb/start/stop) is otherwise reused.
 */
function embeddedPostgresBinaryPlugin() {
  return {
    name: 'embedded-postgres-binaries',
    setup(build) {
      build.onLoad({ filter: /embedded-postgres[\\/]dist[\\/]binary\.js$/ }, () => ({
        loader: 'js',
        contents: [
          "import path from 'node:path';",
          'export default function getBinaries() {',
          '  const dir = process.env.EMBEDDED_POSTGRES_BIN_DIR;',
          "  if (!dir) throw new Error('EMBEDDED_POSTGRES_BIN_DIR is not set (packaged build).');",
          "  const ext = process.platform === 'win32' ? '.exe' : '';",
          '  return Promise.resolve({',
          "    initdb: path.join(dir, 'initdb' + ext),",
          "    pg_ctl: path.join(dir, 'pg_ctl' + ext),",
          "    postgres: path.join(dir, 'postgres' + ext),",
          "    psql: path.join(dir, 'psql' + ext),",
          '  });',
          '}'
        ].join('\n')
      }))
    }
  }
}

/** Downloads the pinned WinSW wrapper to the cache (checksum-verified) and returns its path. */
async function ensureWinsw() {
  const cachePath = path.join(cacheDir, WINSW.cacheFileName)
  if (!existsSync(cachePath)) {
    console.log('Downloading WinSW service wrapper…')
    await downloadToFile(WINSW.url, cachePath)
  }
  const actual = createHash('sha256').update(readFileSync(cachePath)).digest('hex')
  if (actual !== WINSW.sha256) {
    rmSync(cachePath, { force: true })
    fail('Checksum mismatch for the WinSW service wrapper; deleted the cached file — please retry.')
  }
  return cachePath
}

/** Stages @prisma/client + .prisma/client (engine pruned to the target) and zips them. */
async function buildPrismaAsset() {
  const stage = path.join(workDir, 'prisma-stage')
  const stageModules = path.join(stage, 'node_modules')
  rmSync(stage, { recursive: true, force: true })
  cpSync(path.join(nodeModules, '@prisma', 'client'), path.join(stageModules, '@prisma', 'client'), { recursive: true })
  cpSync(path.join(nodeModules, '.prisma', 'client'), path.join(stageModules, '.prisma', 'client'), { recursive: true })

  const generated = path.join(stageModules, '.prisma', 'client')
  let keptTargetEngine = false
  for (const name of readdirSync(generated)) {
    if (!isEngineBinary(name)) continue
    if (name === serverTarget.engine) keptTargetEngine = true
    else rmSync(path.join(generated, name), { force: true })
  }
  if (!keptTargetEngine) fail(`Prisma engine '${serverTarget.engine}' not found — run db:generate with the right binaryTargets.`)

  return zipDir(stage, path.join(workDir, 'prisma-client.zip'))
}

function isEngineBinary(name) {
  return /\.(so|dylib|dll)\.node$/.test(name) && /^(libquery_engine|query_engine)-/.test(name)
}

/**
 * Zips the target's portable PostgreSQL install (`@embedded-postgres/<key>/native`).
 * `walk()` skips the library symlinks (Dirent.isFile() is false for them); they
 * are rebuilt at extraction from the bundled `pg-symlinks.json`.
 */
async function buildPostgresAsset() {
  return zipDir(ensurePostgresNative(serverTarget.pgKey), path.join(workDir, 'postgres.zip'))
}

/**
 * Resolves the target's portable PostgreSQL `native/` dir, fetching it on demand.
 * The `@embedded-postgres/<key>` packages declare `os`/`cpu`, so npm refuses to
 * *install* a foreign one when cross-building — but `npm pack` downloads the
 * tarball regardless, so we extract that into node_modules. Pinned to the host
 * package's version so all targets use the same PostgreSQL release.
 */
function ensurePostgresNative(pgKey) {
  const dest = path.join(nodeModules, '@embedded-postgres', pgKey)
  const nativeDir = path.join(dest, 'native')
  if (existsSync(nativeDir)) return nativeDir

  const hostPkg = path.join(nodeModules, '@embedded-postgres', SERVER_TARGETS[hostTargetKey()].pgKey, 'package.json')
  if (!existsSync(hostPkg)) fail(`Install @embedded-postgres for the host first (it ships with embedded-postgres).`)
  const version = JSON.parse(readFileSync(hostPkg, 'utf8')).version

  const packDir = path.join(cacheDir, 'pgpack')
  mkdirSync(packDir, { recursive: true })
  console.log(`Fetching @embedded-postgres/${pgKey}@${version}…`)
  execFileSync('npm', ['pack', `@embedded-postgres/${pgKey}@${version}`, '--pack-destination', packDir], { stdio: 'inherit' })
  const tgz = path.join(packDir, `embedded-postgres-${pgKey}-${version}.tgz`)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  execFileSync('tar', ['xzf', tgz, '-C', dest, '--strip-components=1'])
  return nativeDir
}

/**
 * Builds a **private-free** web bundle — the native binary is the public OSS app,
 * so the closed-source web modules (marketing site, platform admin; discovered
 * by `import.meta.glob('./private/...')`) must not be compiled in. Mirrors the
 * public export by building with `apps/web/src/private` absent, then restoring
 * it. Cached so cross-target builds compile the (platform-agnostic) web once.
 */
function buildPublicWebDist() {
  const cached = path.join(cacheDir, 'web-public-dist')
  if (existsSync(cached)) return cached

  const webDir = path.join(repoRoot, 'apps', 'web')
  const privateDir = path.join(webDir, 'src', 'private')
  const stash = path.join(cacheDir, 'web-src-private-stash')
  const hadPrivate = existsSync(privateDir)
  if (hadPrivate) {
    rmSync(stash, { recursive: true, force: true })
    renameSync(privateDir, stash)
  }
  try {
    console.log('Building private-free web bundle…')
    execFileSync('npm', ['run', 'build', '--workspace', '@printstream/web'], { cwd: repoRoot, stdio: 'inherit' })
    rmSync(cached, { recursive: true, force: true })
    cpSync(path.join(webDir, 'dist'), cached, { recursive: true })
  } finally {
    // Restore the source even if the build failed (it is git-tracked regardless).
    if (hadPrivate) renameSync(stash, privateDir)
  }
  return cached
}

/** Stages the migration history + baseline snapshot and zips them. */
async function buildMigrationsAsset() {
  const stage = path.join(workDir, 'migrations-stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(path.join(repoRoot, 'apps', 'api', 'prisma', 'migrations'), path.join(stage, 'migrations'), { recursive: true })
  copyFileSync(path.join(repoRoot, 'apps', 'api', 'prisma', 'baseline.sql'), path.join(stage, 'baseline.sql'))
  return zipDir(stage, path.join(workDir, 'migrations.zip'))
}

/** Zips a directory tree (relative paths, forward slashes) and returns the path. */
function zipDir(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    for (const abs of walk(srcDir)) {
      zip.addFile(abs, path.relative(srcDir, abs).split(path.sep).join('/'))
    }
    const out = createWriteStream(zipPath)
    zip.outputStream.pipe(out)
    out.on('close', () => resolve(zipPath))
    out.on('error', reject)
    zip.end()
  })
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(abs)
    else if (entry.isFile()) yield abs
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') out.target = argv[++i]
    else if (argv[i] === '--node-version') out.nodeVersion = argv[++i]
  }
  return out
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
