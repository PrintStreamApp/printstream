/**
 * Props for a dialog's name field — the one input a naming dialog exists to collect.
 *
 * Owns the two behaviours such a field must have, which were hand-rolled per dialog and so kept
 * being half-implemented: the existing text is FOCUSED AND SELECTED on open, so a rename or a
 * suggested save name can be typed straight over; and ENTER ACCEPTS, so the value can be committed
 * without reaching for the button.
 *
 * Enter is always swallowed (`preventDefault`) even when the field cannot be accepted yet. In a
 * `<form>` dialog the browser would otherwise ALSO fire an implicit submit — the caller's accept
 * would run twice, or run when its own guard said no.
 *
 * The selection fires once per mount, so clicking back into a half-typed name does not re-select
 * and swallow the edit. `PromptDialogProvider` is the counterpart for the generic prompt path: it
 * has the same behaviour plus a caller-supplied selection RANGE (a filename whose extension stays
 * out of the selection), because it is one long-lived dialog serving a queue of prompts.
 */
import { useCallback, useRef, type FocusEvent, type KeyboardEvent } from 'react'

export interface NameInputProps {
  autoFocus: true
  onFocus: (event: FocusEvent<HTMLInputElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

export function useNameInputProps({ onAccept, canAccept = true }: {
  /** Commit the value — the same handler the dialog's confirm button runs. */
  onAccept?: () => void
  /** False while the value is invalid or a save is in flight; Enter is swallowed but does nothing. */
  canAccept?: boolean
} = {}): NameInputProps {
  const hasSelectedRef = useRef(false)

  const onFocus = useCallback((event: FocusEvent<HTMLInputElement>) => {
    if (hasSelectedRef.current) return
    hasSelectedRef.current = true
    event.currentTarget.select()
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    // isComposing: mid-IME-composition Enter commits the candidate, it does not accept the dialog.
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (canAccept) onAccept?.()
  }, [canAccept, onAccept])

  return { autoFocus: true, onFocus, onKeyDown }
}
