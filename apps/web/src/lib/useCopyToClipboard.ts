/**
 * Copy-to-clipboard with the transient "Copied" acknowledgement every caller
 * needs, and the failure handling every caller forgets.
 *
 * `navigator.clipboard` rejects on an insecure origin and when the browser
 * refuses the permission, which is common enough on a LAN-served install that a
 * silent failure would leave the user pressing a button that appears to do
 * nothing. On rejection the flag simply stays false: the value is on screen and
 * selectable, so there is nothing to recover from and nothing worth an alert.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const COPIED_ACKNOWLEDGEMENT_MS = 2000

export function useCopyToClipboard(): { copied: boolean; copy: (value: string) => Promise<void> } {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  // A copy landing just before the panel closes would otherwise set state on an
  // unmounted component when its timer fires.
  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
  }, [])

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), COPIED_ACKNOWLEDGEMENT_MS)
    } catch {
      setCopied(false)
    }
  }, [])

  return { copied, copy }
}
