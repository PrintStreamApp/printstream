/**
 * Shared Node SEA (single-file executable) build harness — the app-agnostic
 * mechanics every PrintStream SEA build needs: the per-target Node download
 * table, checksum-verified Node acquisition, SEA blob generation + postject
 * injection, and the Windows signing step. The standalone SEA build scripts for
 * the cloud bridge and the native self-hosted app both import from here so the
 * two builds stay in lockstep. (Those build scripts are cloud/paid distributions
 * outside the open-source snapshot; this shared harness stays public.)
 *
 * What stays in each app's build script is what differs: which entry to bundle,
 * which assets to embed (WinSW vs Prisma/Postgres/web), the release identity,
 * and any post-processing (the bridge's manifest fragment). ffmpeg is shared
 * because both builds relay printer cameras through it. This module is build
 * tooling, not part of the runtime that gets bundled.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { Readable } from 'node:stream'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

export const SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
// The ONE Node version every distribution ships. The Docker image pins its
// base to the same version (ARG NODE_VERSION in the root Dockerfile) — bump
// both together, deliberately, and let the bump ride through staging. Keeping
// these aligned is load-bearing: a floating Docker tag once picked up a Node
// patch whose TLS regression broke H2D FTPS on Docker installs only.
export const DEFAULT_NODE_VERSION = '22.22.3'

/** Node download coordinates per target key (`${process.platform}-${process.arch}`). */
export const SEA_TARGETS = {
  'linux-x64': { nodeSuffix: 'linux-x64', archive: 'tar.gz', friendly: 'linux-x64', exeSuffix: '' },
  'linux-arm64': { nodeSuffix: 'linux-arm64', archive: 'tar.gz', friendly: 'linux-arm64', exeSuffix: '' },
  'win32-x64': { nodeSuffix: 'win-x64', archive: 'zip', friendly: 'windows-x64', exeSuffix: '.exe' },
  'win32-arm64': { nodeSuffix: 'win-arm64', archive: 'zip', friendly: 'windows-arm64', exeSuffix: '.exe' }
}

export function hostTargetKey() {
  return `${process.platform}-${process.arch}`
}

/** Downloads + parses the published SHASUMS256 for a Node version (cached). */
export async function fetchNodeShasums(nodeVersion, cacheDir) {
  const cachePath = path.join(cacheDir, `SHASUMS256-${nodeVersion}.txt`)
  if (!existsSync(cachePath)) {
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)
    if (!response.ok) fail(`Could not download Node ${nodeVersion} checksums (HTTP ${response.status}).`)
    await writeFile(cachePath, await response.text(), 'utf8')
  }
  const shasums = new Map()
  for (const line of (await readFile(cachePath, 'utf8')).split('\n')) {
    const [hash, name] = line.trim().split(/\s+/)
    if (hash && name) shasums.set(name, hash)
  }
  return shasums
}

/** Downloads + checksum-verifies a target's official Node binary, cached. */
export async function ensureNodeBinary(targetKey, nodeVersion, cacheDir, shasums) {
  const target = SEA_TARGETS[targetKey]
  if (!target) fail(`No Node download mapping for target '${targetKey}'.`)
  const base = `node-v${nodeVersion}-${target.nodeSuffix}`
  const archiveName = `${base}.${target.archive}`
  const binaryCachePath = path.join(cacheDir, `node-v${nodeVersion}-${targetKey}${target.exeSuffix}`)
  if (existsSync(binaryCachePath)) return binaryCachePath

  const archivePath = path.join(cacheDir, archiveName)
  if (!existsSync(archivePath)) {
    console.log(`Downloading ${archiveName}…`)
    await downloadToFile(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archivePath)
  }
  const expected = shasums.get(archiveName)
  if (!expected) fail(`No published checksum for ${archiveName}.`)
  const actual = createHash('sha256').update(await readFile(archivePath)).digest('hex')
  if (actual !== expected) {
    await rm(archivePath, { force: true })
    fail(`Checksum mismatch for ${archiveName}; deleted the cached archive — please retry.`)
  }

  if (target.archive === 'zip') {
    await extractZipEntryToFile(archivePath, `${base}/node.exe`, binaryCachePath)
  } else {
    const extractDir = path.join(cacheDir, `.extract-${targetKey}`)
    await rm(extractDir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })
    runChecked('tar', ['-xzf', archivePath, '-C', extractDir, `${base}/bin/node`])
    await rename(path.join(extractDir, base, 'bin/node'), binaryCachePath)
    await rm(extractDir, { recursive: true, force: true })
  }
  await chmod(binaryCachePath, 0o755)
  return binaryCachePath
}

/** Generates the SEA blob from `main` + `assets` using a host Node binary. */
export async function generateSeaBlob({ hostNode, main, output, assets }) {
  const configPath = `${output}.sea-config.json`
  await writeFile(configPath, JSON.stringify({ main, output, disableExperimentalSEAWarning: true, assets }, null, 2), 'utf8')
  runChecked(hostNode, ['--experimental-sea-config', configPath])
}

/** Injects the SEA blob into a copied Node binary with postject. */
export async function injectSeaBlob({ artifactPath, blobPath }) {
  const { inject } = await import('postject')
  await inject(artifactPath, 'NODE_SEA_BLOB', await readFile(blobPath), {
    sentinelFuse: SEA_SENTINEL_FUSE
  })
}

/**
 * Rewrites a Windows executable's icon and version resources so it presents as
 * the app — not "Node.js" with the Node logo — in Explorer and (the reason this
 * exists) the UAC elevation prompt, which reads `FileDescription`/`ProductName`
 * and the icon. Pure-JS via `resedit`, so it runs on the Linux build host.
 *
 * Run this **before** the SEA blob is injected: postject only adds its own
 * resource, so the branding survives, and keeping the blob injection last means
 * resedit's PE round-trip can never disturb it. `version` is `[a,b,c,d]`.
 *
 * `guiSubsystem` flips the PE subsystem from console (CUI=3) to GUI (2). A
 * GUI-subsystem exe never gets a console window on double-click — the whole
 * point of a self-hosted app the user launches from Explorer and drives through
 * a window + tray. The trade-off is that the same exe run from a terminal prints
 * nothing (its stdout has no console to attach to); the service path is
 * unaffected because WinSW captures stdout through a pipe regardless.
 */
export async function brandWindowsExecutable({ artifactPath, icoBuffer, productName, fileDescription, companyName = productName, version = [1, 0, 0, 0], guiSubsystem = false }) {
  // `ignoreCert` lets resedit parse a still-signed Node binary (the signature is
  // dropped on output — fine, since the strip ran first and CI re-signs after).
  const exe = NtExecutable.from(await readFile(artifactPath), { ignoreCert: true })
  const res = NtExecutableResource.from(exe)

  // IMAGE_SUBSYSTEM_WINDOWS_GUI = 2 (console is 3). Set on the optional header,
  // which is independent of the resource section we rewrite below.
  if (guiSubsystem) {
    exe.newHeader.optionalHeader.subsystem = 2
  }

  // Replace every existing icon group with our icon so whichever one Explorer /
  // the shell picks (the lowest id) shows the brand; fall back to id 1 if none.
  const icons = Data.IconFile.from(icoBuffer).icons.map((entry) => entry.data)
  const groups = Resource.IconGroupEntry.fromEntries(res.entries)
  const targets = groups.length > 0 ? groups.map((group) => ({ id: group.id, lang: group.lang })) : [{ id: 1, lang: 1033 }]
  for (const { id, lang } of targets) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, icons)
  }

  // Version-info strings: FileDescription + ProductName are what UAC displays.
  const existing = Resource.VersionInfo.fromEntries(res.entries)
  const versionInfo = existing[0] ?? Resource.VersionInfo.createEmpty()
  const lang = existing[0]?.lang ?? 1033
  versionInfo.setFileVersion(version[0], version[1], version[2], version[3], lang)
  versionInfo.setProductVersion(version[0], version[1], version[2], version[3], lang)
  versionInfo.setStringValues({ lang, codepage: 1200 }, {
    ProductName: productName,
    FileDescription: fileDescription,
    CompanyName: companyName,
    OriginalFilename: path.basename(artifactPath),
    InternalName: productName,
    FileVersion: version.join('.'),
    ProductVersion: version.join('.')
  })
  versionInfo.outputToResourceEntries(res.entries)

  res.outputResource(exe)
  await writeFile(artifactPath, Buffer.from(exe.generate()))
}

/**
 * Removes the official Node.js Windows Authenticode signature so re-signing
 * (Trusted Signing) does not fail with 0x800700C1. Strip *before* injection.
 * osslsigncode is the cross-platform equivalent of `signtool remove /s`; CI
 * installs it, and local builds without it warn (those aren't re-signed).
 */
export async function stripWindowsAuthenticodeSignature(artifactPath) {
  if (!commandExists('osslsigncode')) {
    console.warn(`WARNING: osslsigncode not found; left the Node.js signature on ${path.basename(artifactPath)}. Windows re-signing (Trusted Signing) will fail with 0x800700C1 until it is stripped.`)
    return
  }
  const stripped = `${artifactPath}.unsigned`
  runChecked('osslsigncode', ['remove-signature', '-in', artifactPath, '-out', stripped])
  await rm(artifactPath, { force: true })
  await rename(stripped, artifactPath)
}

export function commandExists(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== null
}

export function runChecked(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed with exit code ${result.status}.`)
}

export function fail(message) {
  throw new Error(message)
}

/**
 * Static ffmpeg builds embedded into every standalone executable so camera
 * streaming works without any system dependency. The eugeneware/ffmpeg-static
 * b6.1.1 release ships ffmpeg 7.0.x static binaries (GPL) plus per-platform
 * license files that are extracted alongside the binary at runtime. Targets
 * without an upstream build set `asset` to borrow another target's binary
 * (win32-arm64 ships the x64 ffmpeg; Windows 11 ARM64 runs it under x64
 * emulation).
 *
 * Shared by the bridge and the native server builds: `ensureFfmpeg` in
 * `../src/ffmpeg.ts` is what unpacks these at runtime, and a build that omits
 * them leaves every RTSP printer (X/H series) with a dead camera while the TLS
 * ones keep working.
 */
export const FFMPEG_BUILD_TAG = 'b6.1.1'
const FFMPEG_RELEASE_BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_BUILD_TAG}`
const FFMPEG_STATIC = {
  'linux-x64': {
    binarySha256: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
    licenseSha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
  },
  'linux-arm64': {
    binarySha256: '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce',
    licenseSha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
  },
  'win32-x64': {
    binarySha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    licenseSha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
  },
  'win32-arm64': {
    asset: 'win32-x64',
    binarySha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    licenseSha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
  }
}

/** Downloads (checksum-pinned) and brotli-compresses ffmpeg for one target. */
export async function ensureFfmpegAssets(targetKey, cacheDir) {
  const pins = FFMPEG_STATIC[targetKey]
  if (!pins) fail(`No pinned ffmpeg build for target '${targetKey}'.`)

  // Cache by the upstream asset name so targets borrowing another target's
  // binary (win32-arm64 -> win32-x64) share one download.
  const asset = pins.asset ?? targetKey
  const binaryPath = path.join(cacheDir, `ffmpeg-${asset}-${FFMPEG_BUILD_TAG}`)
  const licensePath = path.join(cacheDir, `ffmpeg-license-${asset}-${FFMPEG_BUILD_TAG}.txt`)
  await ensurePinnedDownload(`${FFMPEG_RELEASE_BASE}/ffmpeg-${asset}`, binaryPath, pins.binarySha256, `ffmpeg (${asset})`)
  await ensurePinnedDownload(`${FFMPEG_RELEASE_BASE}/${asset}.LICENSE`, licensePath, pins.licenseSha256, `ffmpeg license (${asset})`)

  // Embedded brotli-compressed (~76 MB -> ~24 MB of executable size); the
  // runtime decompresses once while extracting to the data dir.
  const compressedPath = `${binaryPath}.br`
  if (!existsSync(compressedPath)) {
    console.log(`Compressing ffmpeg (${targetKey})…`)
    const raw = await readFile(binaryPath)
    await writeFile(compressedPath, brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length
      }
    }))
  }
  return { compressedBinaryPath: compressedPath, licensePath }
}

/** Downloads to `cachePath` once and verifies its checksum on every call. */
export async function ensurePinnedDownload(url, cachePath, expectedSha256, label) {
  if (!existsSync(cachePath)) {
    console.log(`Downloading ${label}…`)
    await downloadToFile(url, cachePath)
  }
  const actual = createHash('sha256').update(await readFile(cachePath)).digest('hex')
  if (actual !== expectedSha256) {
    await rm(cachePath, { force: true })
    fail(`Checksum mismatch for ${label}; deleted the cached file — please retry.`)
  }
  return cachePath
}

/** Streams a URL to a file (used for Node, and app assets like ffmpeg/WinSW). */
export async function downloadToFile(url, filePath) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) fail(`Download failed (HTTP ${response.status}): ${url}`)
  await mkdir(path.dirname(filePath), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath))
}

function extractZipEntryToFile(zipPath, entryName, outputPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Could not open zip archive.'))
        return
      }
      zipFile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            reject(streamError ?? new Error('Could not read zip entry.'))
            return
          }
          pipeline(readStream, createWriteStream(outputPath)).then(() => {
            zipFile.close()
            resolve()
          }, reject)
        })
      })
      zipFile.on('end', () => reject(new Error(`${entryName} not found in ${zipPath}.`)))
      zipFile.on('error', reject)
      zipFile.readEntry()
    })
  })
}
