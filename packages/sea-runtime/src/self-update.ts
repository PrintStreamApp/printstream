/**
 * Generic in-place self-update mechanics for a standalone SEA executable,
 * shared by the cloud bridge's standalone build and the self-hosted server app.
 *
 * Owns the packaging-level machinery only: download-and-verify (sha256 + size +
 * Ed25519 detached signature over the sha256 hex), the rename-based executable
 * swap (`exe` -> `exe.old`, `exe.new` -> `exe`; Windows allows renaming a
 * running image), the pending-update state file that counts boot attempts, and
 * crash-loop rollback with a per-fingerprint hold-back. What to download, when,
 * and what "healthy" means stay with the consuming app's driver: the bridge
 * confirms health on successful registration, the server once its stack serves.
 *
 * Contract callers rely on: after `swapExecutableInPlace` + `writeSelfUpdateState`,
 * the app exits with `SERVICE_RESTART_EXIT_CODE` and the service manager restarts
 * it; every boot calls `noteBootAttemptAndMaybeRollback` BEFORE any risky work,
 * and calls `confirmSelfUpdateHealthy` once the app is demonstrably serving.
 * Missing either call breaks rollback in opposite directions (never rolls back /
 * rolls back a healthy build).
 *
 * Counterparts: `apps/bridge/src/private/sea/self-update.ts` (the bridge driver)
 * and `apps/api/src/lib/native-update-apply.ts` (the server driver).
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { createGunzip } from 'node:zlib'

const MAX_BOOT_ATTEMPTS = 3

/** Pending-update bookkeeping written next to the data dir, never the exe. */
export interface SelfUpdateStateFile {
  fromFingerprint: string
  toFingerprint: string
  updatedAt: string
  bootAttempts: number
  backupPath: string
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Verifies the release signing scheme shared by app bundles and standalone
 * binaries: an Ed25519 signature over the artifact's sha256 hex string.
 */
export function verifyDetachedSha256Signature(input: {
  sha256: string
  signature: string
  publicKeyPem: string | undefined
  artifactName: string
}): void {
  if (!input.publicKeyPem) {
    throw new Error('Update signing public key is not configured.')
  }
  const publicKey = createPublicKey(input.publicKeyPem)
  const ok = verify(
    null,
    Buffer.from(input.sha256, 'utf8'),
    publicKey,
    Buffer.from(input.signature, 'base64')
  )
  if (!ok) {
    throw new Error(`${input.artifactName} signature is invalid.`)
  }
}

/**
 * Downloads a release binary to `targetPath` and verifies size, sha256, and the
 * detached signature; the partial file is removed on any failure. The caller
 * supplies the response so app-specific concerns (licensed redirects, origin
 * pinning) stay out of the shared path. The manifest's sha256/sizeBytes always
 * describe the DECOMPRESSED executable, so gzip-published assets are
 * decompressed inline before hashing.
 */
export async function downloadVerifiedExecutable(input: {
  fetchResponse: () => Promise<Response>
  targetPath: string
  sha256: string
  sizeBytes: number
  signature: string
  publicKeyPem: string | undefined
  compression?: 'gzip' | undefined
  artifactName: string
}): Promise<void> {
  await rm(input.targetPath, { force: true })

  const response = await input.fetchResponse()
  if (!response.ok || !response.body) {
    throw new Error(`${input.artifactName} download failed with HTTP ${response.status}.`)
  }
  const hash = createHash('sha256')
  const hashTap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  const downloadStream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
  const fileStream = createWriteStream(input.targetPath, { mode: 0o755 })
  if (input.compression === 'gzip') {
    await pipeline(downloadStream, createGunzip(), hashTap, fileStream)
  } else {
    await pipeline(downloadStream, hashTap, fileStream)
  }

  try {
    const downloaded = await stat(input.targetPath)
    if (downloaded.size !== input.sizeBytes) {
      throw new Error(`${input.artifactName} size does not match the manifest.`)
    }
    if (hash.digest('hex') !== input.sha256) {
      throw new Error(`${input.artifactName} checksum does not match the manifest.`)
    }
    verifyDetachedSha256Signature({
      sha256: input.sha256,
      signature: input.signature,
      publicKeyPem: input.publicKeyPem,
      artifactName: input.artifactName
    })
    await chmod(input.targetPath, 0o755).catch(() => undefined)
  } catch (error) {
    await rm(input.targetPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Replaces the executable via renames and returns the backup path holding the
 * previous binary. On failure the original executable is restored.
 */
export async function swapExecutableInPlace(input: {
  exePath: string
  newFilePath: string
}): Promise<string> {
  const backupPath = await clearOrDisplace(`${input.exePath}.old`)
  await rename(input.exePath, backupPath)
  try {
    await rename(input.newFilePath, input.exePath)
  } catch (error) {
    await rename(backupPath, input.exePath).catch(() => undefined)
    throw error
  }
  return backupPath
}

/**
 * Removes the previous backup if possible. A locked leftover (Windows) is
 * shoved aside instead so the swap can proceed with a unique backup name.
 */
async function clearOrDisplace(backupPath: string): Promise<string> {
  try {
    await rm(backupPath, { force: true })
    return backupPath
  } catch {
    return `${backupPath}-${Date.now()}`
  }
}

export type BootAttemptOutcome = 'no-pending-update' | 'counted' | 'rolled-back'

/**
 * Startup hook: while a self-update is pending health confirmation, count this
 * boot. After too many unconfirmed attempts, restore the backed-up binary and
 * hold the failed build back so an automatic updater does not loop on it.
 */
export async function noteBootAttemptAndMaybeRollback(input: {
  updateStateFile: string
  heldBackFile: string
  exePath: string
  maxAttempts?: number
}): Promise<BootAttemptOutcome> {
  const state = await readSelfUpdateState(input.updateStateFile)
  if (!state) return 'no-pending-update'

  const attempts = state.bootAttempts + 1
  const maxAttempts = input.maxAttempts ?? MAX_BOOT_ATTEMPTS
  if (attempts > maxAttempts && await pathExists(state.backupPath)) {
    const failedPath = `${input.exePath}.failed`
    await rm(failedPath, { force: true }).catch(() => undefined)
    await rename(input.exePath, failedPath)
    try {
      await rename(state.backupPath, input.exePath)
    } catch (error) {
      await rename(failedPath, input.exePath).catch(() => undefined)
      throw error
    }
    await writeHeldBackFingerprint(input.heldBackFile, state.toFingerprint)
    await rm(input.updateStateFile, { force: true }).catch(() => undefined)
    console.error(`Build ${state.toFingerprint.slice(0, 12)} failed to start ${maxAttempts} times after self-update; rolled back and held the build back.`)
    return 'rolled-back'
  }

  await writeSelfUpdateState(input.updateStateFile, { ...state, bootAttempts: attempts })
  return 'counted'
}

/**
 * Manual rollback (`update rollback`): restores the preserved previous binary
 * over the current one and holds the abandoned build back from auto-retry.
 */
export async function rollbackSelfUpdate(input: {
  exePath: string
  updateStateFile: string
  heldBackFile: string
}): Promise<void> {
  const state = await readSelfUpdateState(input.updateStateFile)
  const backupPath = state?.backupPath ?? `${input.exePath}.old`
  if (!await pathExists(backupPath)) {
    throw new Error('No previous binary is available to roll back to.')
  }
  const discardedPath = `${input.exePath}.rollback-tmp`
  await rm(discardedPath, { force: true }).catch(() => undefined)
  await rename(input.exePath, discardedPath)
  try {
    await rename(backupPath, input.exePath)
  } catch (error) {
    await rename(discardedPath, input.exePath).catch(() => undefined)
    throw error
  }
  await rm(discardedPath, { force: true }).catch(() => undefined)
  if (state) {
    await writeHeldBackFingerprint(input.heldBackFile, state.toFingerprint)
  }
  await rm(input.updateStateFile, { force: true }).catch(() => undefined)
}

/** Finalizes a pending self-update: drops the rollback backup and bookkeeping. */
export async function confirmSelfUpdateHealthy(input: {
  updateStateFile: string
  exePath: string
}): Promise<boolean> {
  const state = await readSelfUpdateState(input.updateStateFile)
  if (!state) return false
  await rm(state.backupPath, { force: true }).catch(() => undefined)
  await rm(`${input.exePath}.failed`, { force: true }).catch(() => undefined)
  await rm(`${input.exePath}.new`, { force: true }).catch(() => undefined)
  await rm(input.updateStateFile, { force: true })
  return true
}

export async function readHeldBackFingerprint(heldBackFile: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(heldBackFile, 'utf8')) as { sourceFingerprint?: unknown }
    return typeof parsed.sourceFingerprint === 'string' ? parsed.sourceFingerprint : null
  } catch {
    return null
  }
}

/** Drops a hold-back that no longer matches the channel's current build. */
export async function clearStaleHoldBack(heldBackFile: string, currentFingerprint: string): Promise<void> {
  const heldBack = await readHeldBackFingerprint(heldBackFile)
  if (heldBack && heldBack !== currentFingerprint) {
    await rm(heldBackFile, { force: true }).catch(() => undefined)
  }
}

async function writeHeldBackFingerprint(heldBackFile: string, fingerprint: string): Promise<void> {
  await writeFile(heldBackFile, JSON.stringify({
    sourceFingerprint: fingerprint,
    failedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8').catch(() => undefined)
}

export async function readSelfUpdateState(filePath: string): Promise<SelfUpdateStateFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SelfUpdateStateFile>
    if (
      typeof parsed.fromFingerprint !== 'string' ||
      typeof parsed.toFingerprint !== 'string' ||
      typeof parsed.backupPath !== 'string' ||
      typeof parsed.bootAttempts !== 'number'
    ) {
      return null
    }
    return {
      fromFingerprint: parsed.fromFingerprint,
      toFingerprint: parsed.toFingerprint,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      bootAttempts: parsed.bootAttempts,
      backupPath: parsed.backupPath
    }
  } catch {
    return null
  }
}

export async function writeSelfUpdateState(filePath: string, state: SelfUpdateStateFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false)
}
