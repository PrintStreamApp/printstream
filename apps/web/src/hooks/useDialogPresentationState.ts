/**
 * State behind a dialog's size modes (see `lib/dialogPresentation.ts` for what each mode looks like).
 *
 * Owns the two toggles and the rule that separates them:
 *
 *  - MAXIMIZED is a size preference and is remembered per device.
 *  - FULL SCREEN hides the dialog's chrome — in an editor that includes Save — so it is deliberately
 *    NEVER persisted: a mode that hides the way to keep your work must not be what greets you on
 *    open. It implies maximized, being the same intent taken all the way.
 *
 * The maximized preference is written only when the user actually toggles it, so a dialog that is
 * merely opened leaves no storage entry behind.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  resolveDialogPresentation,
  type DialogPresentation,
  type DialogPresentationInputs
} from '../lib/dialogPresentation'

export interface DialogPresentationStateOptions extends Pick<DialogPresentationInputs, 'base' | 'locked'> {
  /**
   * localStorage key for the maximized preference. Pass `null` for a dialog with no maximize toggle
   * (one whose `base` is already `maximized`) — nothing is read or written.
   */
  maximizedStorageKey: string | null
}

export interface DialogPresentationState {
  presentation: DialogPresentation
  maximized: boolean
  setMaximized: (next: boolean) => void
  fullScreen: boolean
  setFullScreen: (next: boolean) => void
}

function readMaximizedPreference(key: string | null, fallback: boolean): boolean {
  if (!key || typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw === 'true' ? true : raw === 'false' ? false : fallback
  } catch {
    return fallback
  }
}

export function useDialogPresentationState(options: DialogPresentationStateOptions): DialogPresentationState {
  const { maximizedStorageKey, base, locked } = options
  const [maximized, setMaximizedState] = useState(() => readMaximizedPreference(maximizedStorageKey, base === 'maximized'))
  const [fullScreen, setFullScreen] = useState(false)

  const setMaximized = useCallback((next: boolean) => {
    setMaximizedState(next)
    if (!maximizedStorageKey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(maximizedStorageKey, String(next))
    } catch {
      /* ignore unavailable storage */
    }
  }, [maximizedStorageKey])

  const presentation = useMemo(
    () => resolveDialogPresentation({ maximized, fullScreen, base, locked }),
    [base, fullScreen, locked, maximized]
  )

  return { presentation, maximized, setMaximized, fullScreen, setFullScreen }
}
