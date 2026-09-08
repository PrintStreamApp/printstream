import { useCallback, useEffect, useRef, type ComponentProps } from 'react'
import { Modal } from '@mui/joy'
import React from 'react'
import { setAppBusy } from '../lib/appBusy'

type JoyModalProps = ComponentProps<typeof Modal>
type BackAwareModalOnClose = NonNullable<JoyModalProps['onClose']>

interface BackAwareModalProps extends JoyModalProps {
  /**
   * Let a click on the scrim dismiss this dialog. Off for every dialog by default.
   *
   * The app-wide rule is that a dialog closes only when the user aims at something that
   * says it closes it -- the X, Cancel, Escape, or browser Back. A scrim click is none of
   * those: it is the gesture a misjudged click at a dialog's edge produces, and the cost of
   * getting it wrong is asymmetric, because the dialogs it is easiest to overshoot are the
   * wide ones (print prep, the slot editor, the 3MF editor) that hold the most unsaved work.
   *
   * Opt in only where the surface holds nothing to lose AND the scrim reads as "the thing
   * I am looking past", which in practice means an image viewer. Anything with a field in
   * it does not qualify.
   */
  dismissOnBackdropClick?: boolean
}

const dialogHistoryStackStateKey = '__printStreamDialogStack'

/**
 * Marks the synthetic event a Back gesture closes a dialog with, so a consumer can tell it from
 * the X. Both arrive as `closeClick` and mean the same thing to a dialog, so this is deliberately
 * not part of the reason: it is for DIAGNOSTICS, where naming the actual gesture is the point.
 */
const backGestureCloseKey = '__printStreamBackGestureClose'

/**
 * Was this close request the browser Back gesture rather than the dialog's own close affordance?
 *
 * Both report `closeClick` (Joy's reason enum has three members and no room for a fourth), which is
 * right for deciding what to DO. It is wrong for reporting what happened: `useEditorSave` logs the
 * pair of sources behind a duplicate close request precisely so an intermittent one can be traced,
 * and "the X" and "Back" are the two candidates a reader most needs to tell apart.
 */
export function isBackGestureClose(event: unknown): boolean {
  return typeof event === 'object'
    && event !== null
    && (event as Record<string, unknown>)[backGestureCloseKey] === true
}

interface ActiveDialogEntry {
  token: string
  requestClose: () => void
}

interface ScrollPosition {
  x: number
  y: number
}

let dialogHistoryTokenCounter = 0
let dialogHistoryListenerInstalled = false
let dialogManualScrollRestorationDepth = 0
let previousHistoryScrollRestoration: History['scrollRestoration'] | null = null
const activeDialogEntries: ActiveDialogEntry[] = []
const dismissedDialogTokens = new Set<string>()
const closingDialogTokensFromHistory = new Set<string>()
const dialogOpenScrollPositions = new Map<string, ScrollPosition>()
const dialogCloseScrollPositions = new Map<string, ScrollPosition>()

function createDialogHistoryToken() {
  dialogHistoryTokenCounter += 1
  return `dialog-${dialogHistoryTokenCounter}`
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function readDialogHistoryStack(state: unknown): string[] {
  if (state == null || typeof state !== 'object') return []
  const stack = (state as Record<string, unknown>)[dialogHistoryStackStateKey]
  return isStringArray(stack) ? stack : []
}

function buildDialogHistoryState(stack: string[]) {
  const currentState = window.history.state
  const baseState = currentState != null && typeof currentState === 'object'
    ? currentState as Record<string, unknown>
    : {}
  return {
    ...baseState,
    [dialogHistoryStackStateKey]: stack
  }
}

function getActiveDialogStack() {
  return activeDialogEntries.map((entry) => entry.token)
}

function areDialogStacksEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function isDialogStackPrefix(prefix: string[], full: string[]) {
  return prefix.length <= full.length && prefix.every((entry, index) => entry === full[index])
}

function isTopHistoryDialog(token: string) {
  const stack = readDialogHistoryStack(window.history.state)
  return stack[stack.length - 1] === token
}

function replaceCurrentDialogHistoryWithActiveStack() {
  window.history.replaceState(buildDialogHistoryState(getActiveDialogStack()), document.title)
}


/**
 * Mirror "is any dialog open" into the app-busy registry.
 *
 * An open dialog is treated as work in progress: it is almost always a half-filled form
 * or a decision the user is partway through, none of which survives a reload. So it holds
 * off an automatic update the same way an upload does (`lib/appStaleness.ts`).
 *
 * Hung off this stack rather than off each dialog because this is where every dialog
 * already announces itself, so a new one is covered without remembering to opt in.
 */
function syncDialogBusyState() {
  setAppBusy('dialog-open', activeDialogEntries.length > 0)
}

function registerActiveDialog(token: string, requestClose: () => void) {
  const existingEntry = activeDialogEntries.find((entry) => entry.token === token)
  if (existingEntry) {
    existingEntry.requestClose = requestClose
    return false
  }
  activeDialogEntries.push({ token, requestClose })
  syncDialogBusyState()
  return true
}

function unregisterActiveDialog(token: string) {
  const entryIndex = activeDialogEntries.findIndex((entry) => entry.token === token)
  if (entryIndex === -1) return false
  activeDialogEntries.splice(entryIndex, 1)
  disableDialogManualScrollRestoration()
  syncDialogBusyState()
  return true
}

function handleDialogHistoryPopState(event: PopStateEvent) {
  const nextStack = readDialogHistoryStack(event.state)
  const currentStack = getActiveDialogStack()

  if (areDialogStacksEqual(nextStack, currentStack)) return

  if (isDialogStackPrefix(nextStack, currentStack)) {
    const dialogsToClose = activeDialogEntries.slice(nextStack.length).reverse()
    const scrollPosition = readWindowScrollPosition()
    dialogsToClose.forEach((entry) => {
      dismissedDialogTokens.add(entry.token)
      closingDialogTokensFromHistory.add(entry.token)
      dialogCloseScrollPositions.set(entry.token, scrollPosition)
      entry.requestClose()
    })
    return
  }

  const isStaleDialogEntry = nextStack.some((token) => dismissedDialogTokens.has(token)) || !isDialogStackPrefix(currentStack, nextStack)
  if (!isStaleDialogEntry) return

  queueMicrotask(() => {
    replaceCurrentDialogHistoryWithActiveStack()
    if (window.history.length > 1) window.history.back()
  })
}

function installDialogHistoryListener() {
  if (dialogHistoryListenerInstalled) return
  window.addEventListener('popstate', handleDialogHistoryPopState)
  dialogHistoryListenerInstalled = true
}

function enableDialogManualScrollRestoration() {
  if (dialogManualScrollRestorationDepth === 0) {
    previousHistoryScrollRestoration = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
  }
  dialogManualScrollRestorationDepth += 1
}

function disableDialogManualScrollRestoration() {
  if (dialogManualScrollRestorationDepth === 0) return
  dialogManualScrollRestorationDepth -= 1
  if (dialogManualScrollRestorationDepth > 0) return
  if (previousHistoryScrollRestoration != null) {
    window.history.scrollRestoration = previousHistoryScrollRestoration
    previousHistoryScrollRestoration = null
  }
}

function readWindowScrollPosition(): ScrollPosition {
  return {
    x: window.scrollX,
    y: window.scrollY
  }
}

function restoreWindowScrollPosition(position: ScrollPosition | undefined) {
  if (!position) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.scrollTo({ left: position.x, top: position.y, behavior: 'auto' })
    })
  })
}

/**
 * Joy Modal wrapper that treats browser Back as dialog dismissal.
 *
 * This is adapted from game-is-up's `DashboardModal`: each open dialog
 * appends a token to a history-backed stack, and browser Back closes the
 * top dialog instead of navigating away.
 *
 * The entry is spent when the dialog CLOSES (`syncClosedDialog`), never when one is
 * requested: `onClose` is a question the consumer may answer with "no", and popping
 * first desynchronised the stack from the dialogs actually open. See `handleClose`.
 *
 * It also owns the app's DISMISSAL SET, which is the deliberate gestures only: the X,
 * a footer button, Escape, and browser Back. A click on the scrim is not one of them and
 * never reaches the consumer's `onClose` -- see `dismissOnBackdropClick`, and note that
 * this is why the reason a dialog receives for Back is `closeClick`.
 */
export function BackAwareModal({ open, onClose, dismissOnBackdropClick = false, ...props }: BackAwareModalProps) {
  const previousOpenRef = useRef(open)
  const onCloseRef = useRef(onClose)
  const dialogTokenRef = useRef<string | null>(null)

  onCloseRef.current = onClose

  /**
   * A real Back press (or a Back that popped past this dialog). It reports `closeClick`, the
   * Joy reason for "the user aimed at something that dismisses this": Back is a deliberate
   * dismissal gesture, and on a phone it is the primary one. It used to report `backdropClick`
   * as the closest reason for "dismissed from outside the dialog", which stopped being usable
   * once a scrim click became a NON-close -- `handleClose` would have swallowed Back with it.
   *
   * Back and the X are one reason on purpose, because they ask a dialog for the same thing. Where
   * the two must be TOLD APART (a diagnostic naming the gesture, never a decision about what to
   * do), the event carries the marker `isBackGestureClose` reads.
   */
  const requestClose = useCallback(() => {
    onCloseRef.current?.({ [backGestureCloseKey]: true }, 'closeClick')
  }, [])

  const syncClosedDialog = useCallback((token: string, closeViaHistory: boolean) => {
    const closedFromHistory = closingDialogTokensFromHistory.delete(token)
    const scrollPosition = dialogOpenScrollPositions.get(token) ?? dialogCloseScrollPositions.get(token)
    dialogOpenScrollPositions.delete(token)
    dialogCloseScrollPositions.delete(token)
    dismissedDialogTokens.add(token)
    unregisterActiveDialog(token)
    dialogTokenRef.current = null

    if (!closedFromHistory && closeViaHistory && isTopHistoryDialog(token) && window.history.length > 1) {
      window.history.back()
      return
    }

    restoreWindowScrollPosition(scrollPosition)
  }, [])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return

    installDialogHistoryListener()
    const scrollPosition = readWindowScrollPosition()
    const dialogToken = dialogTokenRef.current ?? createDialogHistoryToken()
    dialogTokenRef.current = dialogToken
    dialogOpenScrollPositions.set(dialogToken, scrollPosition)

    const didRegister = registerActiveDialog(dialogToken, requestClose)
    if (didRegister) {
      enableDialogManualScrollRestoration()
      window.history.pushState(buildDialogHistoryState(getActiveDialogStack()), document.title)
    }

    restoreWindowScrollPosition(scrollPosition)
  }, [open, requestClose])

  useEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = open
    if (open || !wasOpen || typeof window === 'undefined') return

    const dialogToken = dialogTokenRef.current
    if (dialogToken) {
      syncClosedDialog(dialogToken, true)
    }
  }, [open, syncClosedDialog])

  useEffect(() => {
    return () => {
      const dialogToken = dialogTokenRef.current
      if (!dialogToken) return
      closingDialogTokensFromHistory.delete(dialogToken)
      dialogOpenScrollPositions.delete(dialogToken)
      dialogCloseScrollPositions.delete(dialogToken)
      dismissedDialogTokens.add(dialogToken)
      unregisterActiveDialog(dialogToken)
      dialogTokenRef.current = null
    }
  }, [])

  /**
   * A close REQUEST, never a close: `onClose` is the consumer's to answer.
   *
   * Every reason is handed straight over without touching history, and the entry is spent by
   * `syncClosedDialog` if the dialog actually closes -- which is the only moment that knows.
   * Hopping first spent the entry either way, which is wrong for any dialog that can DECLINE:
   * the 3MF editor backs out of its active tool on Escape, and answers "Discard unsaved changes?"
   * before it closes at all. A declined close then left the dialog open with nothing behind it,
   * so Back navigated the route away instead of closing it, and the next dialog opened over it
   * pushed a stack (`[editor, inner]`) that the entry underneath (`[]`) no longer matched -- so
   * closing THAT dialog popped to a stack prefixing this one and fired this `onClose` again,
   * raising "Discard unsaved changes?" a second time over a gesture nobody made.
   *
   * Escape alone was exempted first, which fixed the tool case and left the discard case: reaching
   * the prompt through the X or the scrim still spent the entry before the user had answered it.
   *
   * A scrim click is dropped here rather than passed on, so no dialog has to remember to ignore
   * it: MUI removed `disableBackdropClick` in v5 and documents exactly this check as the
   * replacement. See `dismissOnBackdropClick` for the opt-out and why it is off by default.
   */
  const handleClose = useCallback<BackAwareModalOnClose>((event, reason) => {
    if (reason === 'backdropClick' && !dismissOnBackdropClick) return
    onCloseRef.current?.(event, reason)
  }, [dismissOnBackdropClick])

  return <Modal open={open} onClose={handleClose} disableAutoFocus disableRestoreFocus {...props} />
}
