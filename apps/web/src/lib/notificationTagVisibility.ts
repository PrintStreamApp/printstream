/**
 * Registry of notification collapse tags whose subject surface is currently
 * on screen (e.g. an open support conversation dialog claims
 * `support:<conversationId>`).
 *
 * Before showing a push notification, the notifications-browser service
 * worker (`public/push-handler.js`) asks each visible window client whether
 * the notification's tag is claimed here; if it is — and the document is
 * focused — the OS notification is suppressed, because the user is already
 * looking at the thing it would announce. Core owns the registry so any
 * surface (core, plugin, or private module) can claim a tag without
 * importing the notifications plugin.
 */
import { useEffect } from 'react'

const claimedTags = new Map<string, number>()

/**
 * Mark a tag's subject surface as on screen. Counted, so overlapping
 * claimants compose; returns the (idempotent) release function.
 */
export function claimNotificationTagVisible(tag: string): () => void {
  claimedTags.set(tag, (claimedTags.get(tag) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = claimedTags.get(tag) ?? 0
    if (count <= 1) claimedTags.delete(tag)
    else claimedTags.set(tag, count - 1)
  }
}

/**
 * Whether the tag's surface is on screen right now: claimed by a mounted
 * surface AND the document is visible and focused (a claim in a background
 * tab or unfocused window does not suppress notifications).
 */
export function isNotificationTagVisible(tag: string): boolean {
  if (!tag || !claimedTags.has(tag)) return false
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Claim `tag` (when non-empty) for the lifetime of the calling component. */
export function useNotificationTagVisibilityClaim(tag: string | null | undefined): void {
  useEffect(() => {
    if (!tag) return
    return claimNotificationTagVisible(tag)
  }, [tag])
}
