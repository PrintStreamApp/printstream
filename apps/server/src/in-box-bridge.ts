/**
 * The in-box managed bridge.
 *
 * A single-box install still needs LAN access to printers. Rather than make the
 * operator run a separate bridge, the server runs the bridge runtime **in the
 * same process** as the API, in managed-bridge mode: the API generates a
 * provisioning token, the bridge reads the same token file and presents it on
 * registration, and the API auto-pairs it into the sole workspace. The bridge is
 * an outbound client (it dials the API), so there is no second listening port to
 * coordinate — it just connects to `http://localhost:<port>` over loopback.
 *
 * This mirrors the Docker `bridge` service's environment (`BRIDGE_SERVER_URL`,
 * `BRIDGE_LIBRARY_DIR`, `BRIDGE_STATE_FILE`, the shared `MANAGED_BRIDGE_TOKEN_FILE`),
 * but co-located in one executable. Set `MANAGED_BRIDGE=false` to turn it off and
 * pair a remote bridge by hand instead.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ServerPaths } from './app-identity.js'

/** Whether the in-box managed bridge should run (default on for the native app). */
export function isManagedBridgeEnabled(): boolean {
  return (process.env.MANAGED_BRIDGE ?? '').trim().toLowerCase() === 'true'
}

/**
 * Ensures the managed-bridge provisioning token exists before either the API or
 * the bridge reads it, so the two agree on the secret with no startup race. The
 * API would otherwise create it on listen; pre-creating it here is the simplest
 * way to remove the ordering dependency.
 */
export function ensureProvisionToken(tokenFile: string): void {
  try {
    if (readFileSync(tokenFile, 'utf8').trim()) return
  } catch {
    // Missing or unreadable — create it.
  }
  mkdirSync(path.dirname(tokenFile), { recursive: true })
  writeFileSync(tokenFile, randomBytes(32).toString('base64url'), { mode: 0o600 })
}

/**
 * Starts the bridge runtime in-process. Sets the bridge's environment (only when
 * unset, so an operator can override) and then dynamically imports the runtime —
 * the bridge captures its env at construction, so the import must come last.
 * `start()` is fire-and-forget with error logging, exactly as the standalone
 * bridge entry does.
 */
export async function startInBoxBridge(paths: ServerPaths, port: number): Promise<void> {
  setDefault('BRIDGE_SERVER_URL', `http://localhost:${port}`)
  setDefault('BRIDGE_DATA_DIR', paths.dataDir)
  setDefault('BRIDGE_LIBRARY_DIR', paths.libraryDir)
  setDefault('BRIDGE_STATE_FILE', path.join(paths.dataDir, 'bridge-state.json'))
  setDefault('BRIDGE_NAME', 'PrintStream')

  const { BridgeRuntimeClient } = await import('@printstream/bridge/runtime')
  const runtime = new BridgeRuntimeClient()
  void runtime.start().catch((error) => {
    console.error('In-box bridge runtime error', error)
  })
  console.log('Started the in-box printer connection service (managed bridge).')
}

function setDefault(key: string, value: string): void {
  if (process.env[key] === undefined) process.env[key] = value
}
