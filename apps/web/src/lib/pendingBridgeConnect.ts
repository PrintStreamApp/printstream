/**
 * Carries a bridge connect code from the workspace-agnostic `/connect-bridge`
 * deep link to the workspace-scoped Bridges settings page.
 *
 * The connect API is bound to the active workspace context, so the deep link first
 * routes the user into their chosen workspace (a context switch + navigation)
 * before the Bridges page can submit the code. Threading the code through that
 * switch as a query string is fragile, so it rides in sessionStorage instead:
 * stashed when the deep link resolves, consumed once by the Bridges page. Using
 * sessionStorage (not the URL) also keeps the connect code out of the address
 * bar after it has been used.
 */
import { readStoredValue, removeStoredValue, writeStoredValue } from './browserStorageKeys'
import { pendingBridgeConnectCodeKey } from './storageKeys'

/** Records the connect code to pre-fill once the Bridges page renders. */
export function stashPendingBridgeConnectCode(code: string): void {
  const trimmed = code.trim()
  if (!trimmed) return
  // Best-effort: private-mode or quota failures are non-fatal, the user can still type the code.
  writeStoredValue(pendingBridgeConnectCodeKey, trimmed)
}

/** Reads and clears the stashed connect code (single use). */
export function consumePendingBridgeConnectCode(): string | null {
  const code = readStoredValue(pendingBridgeConnectCodeKey)
  if (code) removeStoredValue(pendingBridgeConnectCodeKey)
  return code && code.trim() ? code.trim() : null
}
