/**
 * Persisted bridge identity store.
 *
 * Reads/writes the bridge's `bridgeId` + `runtimeToken` to a JSON file so the
 * bridge re-registers as the same bridge across restarts. Reads return null on
 * any missing/corrupt/incomplete file; the runtime clears the file when the API
 * rejects the stored credentials.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface BridgeState {
  bridgeId: string
  runtimeToken: string
}

export async function readBridgeState(filePath: string): Promise<BridgeState | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<BridgeState>
    if (typeof parsed.bridgeId !== 'string' || typeof parsed.runtimeToken !== 'string') {
      return null
    }
    return {
      bridgeId: parsed.bridgeId,
      runtimeToken: parsed.runtimeToken
    }
  } catch {
    return null
  }
}

export async function writeBridgeState(filePath: string, state: BridgeState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

export async function clearBridgeState(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined)
}

export type { BridgeState }