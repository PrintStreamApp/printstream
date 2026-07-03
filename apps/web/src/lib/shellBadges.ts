/**
 * Tiny external store for shell-tab notification badges.
 *
 * Core owns only the mechanism: `AppShell` renders a dot on any tab whose
 * `value` is in the set, and plugins (or private modules) drive it — e.g. the
 * cloud support plugin marks the Account tab when the platform has replied to
 * one of the user's conversations, and the platform Messages tab when a
 * workspace message is unread. Removing every writer leaves all tabs undotted.
 */
import { useSyncExternalStore } from 'react'

let badgedTabValues: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Mark or clear the notification dot on the tab with this `ShellTab.value`. */
export function setShellTabBadge(tabValue: string, active: boolean): void {
  if (badgedTabValues.has(tabValue) === active) return
  const next = new Set(badgedTabValues)
  if (active) next.add(tabValue)
  else next.delete(tabValue)
  badgedTabValues = next
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The set of tab values that currently show a notification dot. */
export function useShellTabBadges(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => badgedTabValues)
}
