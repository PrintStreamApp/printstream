/**
 * Post-sign-in passkey setup prompt state.
 *
 * Sign-in flows that watch a user authenticate without a passkey (email-code
 * verify, cloud self-registration) raise a sessionStorage flag here; the
 * auth-local plugin's shell overlay consumes it after navigation and offers to
 * create a passkey while the fresh session still satisfies the
 * recent-verification requirement on the registration endpoints.
 *
 * This lives in core lib (not the plugin) so private cloud code can raise the
 * flag without importing from a plugin. The flag is deliberately dumb: raising
 * it only records "this sign-in had no passkey"; whether to actually prompt
 * (browser support, per-device dismissal, provider enabled) is decided by the
 * overlay at render time.
 *
 * Dismissals are per user *and* per device (localStorage): declining on a
 * phone should not suppress the offer later on a desktop where a new passkey
 * would still help.
 */
import { readStoredValue, removeStoredValue, writeStoredValue } from './browserStorageKeys'
import { passkeySetupDismissedKeys, passkeySetupPromptKey } from './storageKeys'


/** Raise the flag; the shell overlay offers passkey setup after navigation. */
export function flagPasskeySetupPrompt(): void {
  // Best-effort: with storage unavailable (private mode, quota) the offer is silently skipped.
  writeStoredValue(passkeySetupPromptKey, '1')
}

export function readPasskeySetupPromptFlag(): boolean {
  return readStoredValue(passkeySetupPromptKey) === '1'
}

export function clearPasskeySetupPromptFlag(): void {
  // Best-effort: worst case the offer shows again this session.
  removeStoredValue(passkeySetupPromptKey)
}

/** Record that this user declined the offer on this device. */
export function dismissPasskeySetupPrompt(userId: string): void {
  // Best-effort: without storage the dismissal just does not persist.
  writeStoredValue(passkeySetupDismissedKeys.at(userId), new Date().toISOString())
}

export function isPasskeySetupPromptDismissed(userId: string): boolean {
  return readStoredValue(passkeySetupDismissedKeys.at(userId)) != null
}
