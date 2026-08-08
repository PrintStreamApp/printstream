/**
 * Whether any `BackAwareModal` is currently open.
 *
 * For fixed-position chrome that sits OUTSIDE the dialog and needs to know it is being covered.
 * The one consumer today is the toast stack (`StatusToastStack`), which lifts itself above the
 * mobile tab bar — a lift that has to drop while a dialog is open, because the dialog covers the
 * tab bar and the raised toast would otherwise float in empty space.
 *
 * Reads through `useSyncExternalStore` against the dialog registry's module state, so it is correct
 * for dialogs mounted anywhere in the tree (including portals) rather than only under a provider.
 */
import { useSyncExternalStore } from 'react'
import { getOpenDialogCount, subscribeToOpenDialogs } from '../lib/openDialogRegistry'

export function useAnyDialogOpen(): boolean {
  return useSyncExternalStore(subscribeToOpenDialogs, () => getOpenDialogCount() > 0, () => false)
}
