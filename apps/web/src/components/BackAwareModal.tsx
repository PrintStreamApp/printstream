import { useCallback, useEffect, useRef, type ComponentProps } from 'react'
import { Modal } from '@mui/joy'
import React from 'react'
import { setAppBusy } from '../lib/appBusy'

type BackAwareModalProps = ComponentProps<typeof Modal>
type BackAwareModalOnClose = NonNullable<BackAwareModalProps['onClose']>
type BackAwareModalCloseReason = Parameters<BackAwareModalOnClose>[1]

const dialogHistoryStackStateKey = '__printStreamDialogStack'

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
 * top dialog instead of navigating away. Normal close gestures pop the
 * dialog history entry first so the following Back action still performs
 * normal route navigation.
 */
export function BackAwareModal({ open, onClose, ...props }: BackAwareModalProps) {
  const previousOpenRef = useRef(open)
  const onCloseRef = useRef(onClose)
  const dialogTokenRef = useRef<string | null>(null)

  onCloseRef.current = onClose

  // Why the dialog is closing, carried ACROSS the `history.back()` below. Without it every
  // history-routed close reports `backdropClick`, so a dialog cannot tell Escape from a Back
  // gesture or a click on the scrim. The editor needs that distinction: Escape backs out of its
  // tool, Back closes the whole thing.
  const pendingCloseReasonRef = useRef<BackAwareModalCloseReason | null>(null)

  const requestClose = useCallback(() => {
    // Default to `backdropClick` for a real Back press, which is not routed through `handleClose`
    // and so leaves nothing pending.
    const reason = pendingCloseReasonRef.current ?? 'backdropClick'
    pendingCloseReasonRef.current = null
    onCloseRef.current?.({}, reason)
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

  const handleClose = useCallback<BackAwareModalOnClose>((event, reason) => {
    const dialogToken = dialogTokenRef.current

    if (!dialogToken || typeof window === 'undefined') {
      onCloseRef.current?.(event, reason)
      return
    }

    // Escape is the one reason a consumer routinely DECLINES: the 3MF editor backs out of its
    // active tool, or clears its selection, and stays open. So it is handed straight over without
    // touching history, and the entry is spent by `syncClosedDialog` if the dialog actually closes
    // -- which is the only moment that knows. Hopping first spent the entry either way, leaving a
    // declined Escape with an open dialog and nothing behind it: Back then navigated the route away
    // instead of closing it, and closing a dialog stacked on top popped to a stack that prefixed
    // this one, firing this `onClose` again over a gesture nobody made.
    if (reason === 'escapeKeyDown') {
      onCloseRef.current?.(event, reason)
      return
    }

    dismissedDialogTokens.add(dialogToken)

    if (isTopHistoryDialog(dialogToken) && window.history.length > 1) {
      // Popping the entry re-enters through `requestClose`, which is where `onClose` finally fires.
      pendingCloseReasonRef.current = reason
      window.history.back()
      return
    }

    onCloseRef.current?.(event, reason)
  }, [])

  return <Modal open={open} onClose={handleClose} disableAutoFocus disableRestoreFocus {...props} />
}
