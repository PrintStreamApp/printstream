/**
 * Persisted bridge identity store.
 *
 * Holds a durable `installationId` plus the server-issued `bridgeId` +
 * `runtimeToken`. The installationId is generated once and *survives credential
 * resets*: the runtime drops bridgeId/runtimeToken when the API rejects them
 * (e.g. the bridge was pointed at a different database), but keeps the
 * installationId so the server can recognize the returning physical bridge and
 * re-bind it to its existing record — instead of registering a duplicate and
 * stranding its printers/library.
 *
 * Because losing the installationId is what strands a bridge, the store is
 * hardened against the two ways a full disk or crash can destroy it:
 *   - Writes are atomic (temp file + fsync + rename), so an ENOSPC or crash
 *     mid-write can never truncate the existing good file.
 *   - A file that exists but is unreadable/empty is treated as *corruption*, not
 *     a first run: the loader preserves it and refuses to mint a fresh identity
 *     (which would silently orphan the bridge), surfacing a recoverable error
 *     instead. A genuinely absent file (first run) still generates an id.
 * A legacy file that predates the installationId field is still upgraded in
 * place, preserving any credentials it already holds.
 */
import { copyFile, mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

interface BridgeState {
  installationId: string
  bridgeId?: string
  runtimeToken?: string
}

/**
 * Raised when the state file is present but its contents can't be parsed. The
 * runtime's registration loop logs this and retries with backoff (never crashing
 * and never minting a replacement identity), so the corruption is surfaced for
 * recovery rather than silently costing the bridge its printers and library.
 */
export class CorruptBridgeStateError extends Error {
  readonly filePath: string
  readonly backupPath: string | null

  constructor(filePath: string, backupPath: string | null, options?: { cause?: unknown }) {
    super(
      `Bridge state file ${filePath} exists but is unreadable/corrupt` +
        (backupPath ? ` (a copy was preserved at ${backupPath})` : '') +
        '. Refusing to mint a new install identity, which would strand this bridge\'s ' +
        'printers and library under a duplicate record. Restore the file from a backup, ' +
        'or delete it to re-provision this bridge from scratch.',
      options
    )
    this.name = 'CorruptBridgeStateError'
    this.filePath = filePath
    this.backupPath = backupPath
  }
}

type RawStateRead =
  | { kind: 'missing' }
  | { kind: 'ok'; state: Partial<BridgeState> }
  | { kind: 'corrupt'; cause: unknown }

/**
 * Reads and classifies the state file, distinguishing a genuinely absent file
 * (first run) from one that exists but is empty or unparseable (corruption). The
 * distinction matters: only the former may safely mint a fresh identity.
 */
async function readRawState(filePath: string): Promise<RawStateRead> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  // A zero-byte file is the classic ENOSPC/crash-mid-write artifact of the old
  // non-atomic writer. Treat it as corruption, never as "no file", so we don't
  // blindly overwrite a slot that may have held a real identity.
  if (raw.trim().length === 0) return { kind: 'corrupt', cause: new Error('empty state file') }
  try {
    return { kind: 'ok', state: JSON.parse(raw) as Partial<BridgeState> }
  } catch (error) {
    return { kind: 'corrupt', cause: error }
  }
}

/**
 * Best-effort copy of an unreadable state file to a sibling `.corrupt` path so an
 * operator can inspect/restore it. The original is left untouched so subsequent
 * loads keep failing loudly (rather than falling through to a fresh identity).
 */
async function preserveCorruptState(filePath: string): Promise<string | null> {
  const backupPath = `${filePath}.corrupt`
  try {
    await copyFile(filePath, backupPath)
    return backupPath
  } catch {
    return null
  }
}

/**
 * Loads bridge state, guaranteeing a durable installationId — generating and
 * persisting one on first run (and for a legacy file that predates the field,
 * while preserving any credentials it already holds). Credentials are included
 * only when both `bridgeId` and `runtimeToken` are present.
 *
 * Throws {@link CorruptBridgeStateError} when the file exists but is unreadable,
 * rather than treating it as a first run — minting a replacement identity there
 * is what orphans a returning bridge under a duplicate record.
 */
export async function loadBridgeState(filePath: string): Promise<BridgeState> {
  const read = await readRawState(filePath)

  if (read.kind === 'corrupt') {
    const backupPath = await preserveCorruptState(filePath)
    throw new CorruptBridgeStateError(filePath, backupPath, { cause: read.cause })
  }

  const existing = read.kind === 'ok' ? read.state : undefined
  const credentials = typeof existing?.bridgeId === 'string' && typeof existing?.runtimeToken === 'string'
    ? { bridgeId: existing.bridgeId, runtimeToken: existing.runtimeToken }
    : {}

  if (typeof existing?.installationId === 'string' && existing.installationId.length > 0) {
    return { installationId: existing.installationId, ...credentials }
  }

  const generated: BridgeState = { installationId: randomUUID(), ...credentials }
  await writeBridgeState(filePath, generated)
  return generated
}

/**
 * Persists bridge state atomically: the payload is written to a sibling temp
 * file, flushed to disk, then renamed into place. A crash or full disk (ENOSPC)
 * mid-write therefore fails without ever truncating the existing good file — the
 * durable installationId cannot be lost to a partial write.
 */
export async function writeBridgeState(filePath: string, state: BridgeState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp`
  const payload = JSON.stringify(state, null, 2) + '\n'
  let handle: FileHandle | null = null
  try {
    handle = await open(tempPath, 'w')
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, filePath)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Drops the server-issued credentials (bridgeId + runtimeToken) while keeping the
 * durable installationId, so the next registration re-binds the returning bridge
 * to its record rather than minting a new one.
 */
export async function clearBridgeCredentials(filePath: string, installationId: string): Promise<void> {
  await writeBridgeState(filePath, { installationId })
}

export type { BridgeState }
