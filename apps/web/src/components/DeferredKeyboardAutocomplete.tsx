/**
 * Joy `Autocomplete` that defers the on-screen keyboard on touch devices.
 *
 * On phones and tablets the virtual keyboard appears the moment an autocomplete
 * input focuses and covers most of the option list, so the user can't browse
 * the choices they came for. This wrapper renders the input with
 * `inputMode="none"` on touch-only devices (`useTouchPointer`), so the first
 * tap focuses the field and opens the list keyboard-free. Tapping the
 * already-focused field again lifts the suppression, and that same tap summons
 * the keyboard for type-to-filter. The suppression re-arms on blur. Desktop
 * pointers and hardware keyboards are untouched (`inputMode` only affects
 * virtual keyboards), so this is safe as a drop-in for every autocomplete —
 * use it instead of the bare Joy `Autocomplete` in app UI.
 *
 * Implementation constraint: the repeat-tap listener is attached natively via a
 * ref because Joy's input slot only composes `onBlur`/`onFocus`/`onMouseDown`
 * from `slotProps.input` — any other handler passed there is silently dropped
 * by `mergeSlotProps`.
 */
import { useEffect, useRef, useState } from 'react'
import { Autocomplete } from '@mui/joy'
import type { AutocompleteProps } from '@mui/joy'
import { useTouchPointer } from './useTouchPointer'

function assignRef<T>(ref: React.Ref<T> | null | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value)
  } else if (ref && typeof ref === 'object') {
    ;(ref as React.MutableRefObject<T | null>).current = value
  }
}

export function DeferredKeyboardAutocomplete<
  T,
  Multiple extends boolean | undefined = false,
  DisableClearable extends boolean | undefined = false,
  FreeSolo extends boolean | undefined = false
>({ slotProps, ...rest }: AutocompleteProps<T, Multiple, DisableClearable, FreeSolo>): JSX.Element {
  const touchPointer = useTouchPointer()
  const [typingEnabled, setTypingEnabled] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!touchPointer || !input) {
      return undefined
    }

    const handleTouchStart = () => {
      // A tap on the already-focused field means the user wants to type. Lift the
      // suppression during touchstart — before the tap completes — so this same
      // tap brings up the keyboard instead of needing yet another one.
      if (input.ownerDocument.activeElement === input) {
        setTypingEnabled(true)
      }
    }
    const handleBlur = () => setTypingEnabled(false)

    input.addEventListener('touchstart', handleTouchStart)
    input.addEventListener('blur', handleBlur)
    return () => {
      input.removeEventListener('touchstart', handleTouchStart)
      input.removeEventListener('blur', handleBlur)
    }
  }, [touchPointer])

  return (
    <Autocomplete
      {...rest}
      slotProps={{
        ...slotProps,
        input: (ownerState) => {
          const inputSlotProps = slotProps?.input
          const external = typeof inputSlotProps === 'function' ? inputSlotProps(ownerState) : inputSlotProps
          const externalRef = (external as { ref?: React.Ref<HTMLInputElement> } | undefined)?.ref
          return {
            ...external,
            ref: (node: HTMLInputElement | null) => {
              inputRef.current = node
              assignRef(externalRef, node)
            },
            ...(touchPointer && !typingEnabled ? { inputMode: 'none' as const } : null)
          }
        }
      }}
    />
  )
}
