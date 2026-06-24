/**
 * Persisted bridge identity store.
 *
 * Holds a durable `installationId` plus the server-issued `bridgeId` +
 * `runtimeToken`. The installationId is generated once and *survives credential
 * resets*: the runtime drops bridgeId/runtimeToken when the API rejects them
 * (e.g. the bridge was pointed at a different database), but keeps the
 * installationId so the server can recognize the returning physical bridge and
 * re-bind it to its existing record — instead of registering a duplicate and
 * stranding its printers/library. Reads tolerate a missing/corrupt file and a
 * legacy file that predates the installationId field.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

interface BridgeState {
  installationId: string
  bridgeId?: string
  runtimeToken?: string
}

async function readRawState(filePath: string): Promise<Partial<BridgeState> | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as Partial<BridgeState>
  } catch {
    return null
  }
}

/**
 * Loads bridge state, guaranteeing a durable installationId — generating and
 * persisting one on first run (and for a legacy file that predates the field,
 * while preserving any credentials it already holds). Credentials are included
 * only when both `bridgeId` and `runtimeToken` are present.
 */
export async function loadBridgeState(filePath: string): Promise<BridgeState> {
  const existing = await readRawState(filePath)
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

export async function writeBridgeState(filePath: string, state: BridgeState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
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
