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

const PROMPT_FLAG_KEY = 'printstream.passkeySetupPrompt'
const DISMISSED_KEY_PREFIX = 'printstream.passkeySetupPromptDismissed.'

/** Raise the flag; the shell overlay offers passkey setup after navigation. */
export function flagPasskeySetupPrompt(): void {
  try {
    window.sessionStorage.setItem(PROMPT_FLAG_KEY, '1')
  } catch {
    // Storage unavailable (private mode, quota): silently skip the offer.
  }
}

export function readPasskeySetupPromptFlag(): boolean {
  try {
    return window.sessionStorage.getItem(PROMPT_FLAG_KEY) === '1'
  } catch {
    return false
  }
}

export function clearPasskeySetupPromptFlag(): void {
  try {
    window.sessionStorage.removeItem(PROMPT_FLAG_KEY)
  } catch {
    // Ignore: worst case the offer shows again this session.
  }
}

/** Record that this user declined the offer on this device. */
export function dismissPasskeySetupPrompt(userId: string): void {
  try {
    window.localStorage.setItem(`${DISMISSED_KEY_PREFIX}${userId}`, new Date().toISOString())
  } catch {
    // Ignore: without storage the dismissal just does not persist.
  }
}

export function isPasskeySetupPromptDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISSED_KEY_PREFIX}${userId}`) != null
  } catch {
    return false
  }
}
