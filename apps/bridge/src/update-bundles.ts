/**
 * Signed bridge app-bundle update primitives.
 *
 * These helpers deliberately know nothing about Docker. They only validate
 * release metadata and bundle bytes before later phases stage them under the
 * bridge-owned releases directory.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import yauzl from 'yauzl'
import type { BridgeRelease } from '@printstream/shared'

export function resolveBridgeReleaseUrl(bundleUrl: string, cloudUrl: string): URL {
  const releaseUrl = new URL(bundleUrl)
  const allowedOrigin = new URL(cloudUrl).origin

  if (releaseUrl.origin !== allowedOrigin) {
    throw new Error('Bridge release bundle origin is not trusted.')
  }
  return releaseUrl
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function verifyBridgeReleaseBundle(input: {
  release: BridgeRelease
  bytes: Buffer
  publicKeyPem: string | undefined
}): void {
  if (!input.release.bundle) {
    throw new Error('Bridge release does not include an app bundle.')
  }

  const actualSha256 = sha256Hex(input.bytes)
  if (actualSha256 !== input.release.bundle.sha256) {
    throw new Error('Bridge release bundle checksum does not match the manifest.')
  }
  if (!input.publicKeyPem) {
    throw new Error('Bridge update public key is not configured.')
  }

  const publicKey = createPublicKey(input.publicKeyPem)
  const ok = verify(
    null,
    Buffer.from(input.release.bundle.sha256, 'utf8'),
    publicKey,
    Buffer.from(input.release.bundle.signature, 'base64')
  )
  if (!ok) {
    throw new Error('Bridge release bundle signature is invalid.')
  }
}

export async function stageBridgeReleaseBundle(input: {
  release: BridgeRelease
  bytes: Buffer
  publicKeyPem: string | undefined
  releasesDir: string
}): Promise<string> {
  verifyBridgeReleaseBundle(input)
  const stagingDir = path.join(input.releasesDir, '.staging', input.release.version)
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  await extractZipBuffer(input.bytes, stagingDir)
  await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(input.release, null, 2) + '\n', 'utf8')
  return stagingDir
}

export async function activateBridgeRelease(input: {
  version: string
  releasesDir: string
  stagedDir: string
  entrypoint?: string
  runnerNodeModulesDir?: string
}): Promise<void> {
  const releaseDir = path.join(input.releasesDir, input.version)
  await rm(releaseDir, { recursive: true, force: true })
  await mkdir(input.releasesDir, { recursive: true })
  await rm(releaseDir, { recursive: true, force: true })
  await import('node:fs/promises').then(({ rename }) => rename(input.stagedDir, releaseDir))

  const entrypoint = input.entrypoint ?? 'dist/index.js'
  await ensureRunnerNodeModulesLink(releaseDir, input.runnerNodeModulesDir ?? path.join(process.cwd(), 'node_modules'))
  await access(resolveSafeChildPath(releaseDir, entrypoint))
  const currentPath = path.join(input.releasesDir, 'current.json')
  const previousPath = path.join(input.releasesDir, 'previous.json')
  const existing = await readFile(currentPath, 'utf8').catch(() => null)
  if (existing) {
    await writeFile(previousPath, existing, 'utf8')
  }
  await writeFile(currentPath, JSON.stringify({
    releasePath: input.version,
    entrypoint,
    activatedAt: new Date().toISOString(),
    pendingHealthCheck: true
  }, null, 2) + '\n', 'utf8')
}

async function ensureRunnerNodeModulesLink(releaseDir: string, runnerNodeModulesDir: string): Promise<void> {
  const linkPath = path.join(releaseDir, 'node_modules')
  await access(linkPath).then(() => undefined, async () => {
    await symlink(runnerNodeModulesDir, linkPath, 'dir')
  })
}

async function extractZipBuffer(buffer: Buffer, outputDir: string): Promise<void> {
  const zipFile = await openZipBuffer(buffer)
  await new Promise<void>((resolve, reject) => {
    zipFile.on('entry', (entry) => {
      void extractZipEntry(zipFile, entry, outputDir).then(() => zipFile.readEntry(), reject)
    })
    zipFile.on('end', resolve)
    zipFile.on('error', reject)
    zipFile.readEntry()
  }).finally(() => zipFile.close())
}

function openZipBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Bridge release zip could not be opened.'))
        return
      }
      resolve(zipFile)
    })
  })
}

async function extractZipEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry, outputDir: string): Promise<void> {
  if (isSymlinkEntry(entry)) {
    throw new Error('Bridge release bundle cannot contain symlinks.')
  }
  const outputPath = resolveSafeChildPath(outputDir, entry.fileName)
  if (entry.fileName.endsWith('/')) {
    await mkdir(outputPath, { recursive: true })
    return
  }
  await mkdir(path.dirname(outputPath), { recursive: true })
  const readStream = await openZipReadStream(zipFile, entry)
  await new Promise<void>((resolve, reject) => {
    const writeStream = createWriteStream(outputPath, { flags: 'wx' })
    readStream.on('error', reject)
    writeStream.on('error', reject)
    writeStream.on('finish', resolve)
    readStream.pipe(writeStream)
  })
}

function openZipReadStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, readStream) => {
      if (error || !readStream) {
        reject(error ?? new Error('Bridge release zip entry could not be read.'))
        return
      }
      resolve(readStream)
    })
  })
}

function resolveSafeChildPath(root: string, child: string): string {
  if (child.includes('\\') || path.isAbsolute(child)) {
    throw new Error('Bridge release bundle contains an unsafe path.')
  }
  const normalizedChild = path.posix.normalize(child)
  if (normalizedChild === '..' || normalizedChild.startsWith('../')) {
    throw new Error('Bridge release bundle contains an unsafe path.')
  }
  const resolved = path.resolve(root, normalizedChild)
  const normalizedRoot = path.resolve(root)
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Bridge release bundle contains an unsafe path.')
  }
  return resolved
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000
  return mode === 0o120000
}