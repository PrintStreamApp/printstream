/**
 * Pull-based registry for the tracked identity of the filament loaded in a
 * printer slot: the web analogue of the API's `slot-filament-registry`. Core
 * surfaces that label a physical slot (print-dialog tray pickers, the slice
 * dialog's loaded-material options) resolve the loaded SPOOL through here and
 * feed it into `resolveFilamentIdentity`, so a tracked custom spool reads as
 * itself ("Michael's PLA · White") instead of the printer's generic tray data.
 *
 * The filament-manager plugin registers a hook (from its `init`, before the
 * React tree mounts, so the hook identity is stable for the whole session);
 * Core manual slot identity takes precedence independently of plugin enablement.
 * Otherwise, no active inventory plugin means callers fall back to tray-derived identity.
 */
import { useQuery } from '@tanstack/react-query'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from './workspaceScope'
import { useMemo } from 'react'
import type { FilamentSpoolIdentityInput, PrinterStatus } from '@printstream/shared'
import { useAuthBootstrapQuery } from './authQuery'
import { usePluginCatalogQuery } from './pluginCatalogQuery'
import { isPluginActiveByName } from './pluginSettings'

/** The tracked spool loaded at a slot, in the canonical resolver's spool shape. */
export type SlotFilamentIdentity = FilamentSpoolIdentityInput & {
  spoolId: string | null
  /** The slicing preset (filament profile name) the spool is pinned to; null = auto-match. */
  slicingPresetName?: string | null
  /** Tracked remaining quantity: covers non-RFID spools the printer can't estimate. */
  remainingGrams?: number | null
  remainPercent?: number | null
}

/**
 * Resolve the tracked spool loaded at a physical slot, or null when none is
 * tracked there. `slotId` is null for external spools (amsId 254/255).
 */
export type SlotFilamentIdentityLookup = (
  printerId: string | null | undefined,
  amsId: number | null | undefined,
  slotId: number | null | undefined
) => SlotFilamentIdentity | null

interface SlotFilamentIdentityRegistration {
  pluginName: string
  /** React hook returning the lookup; `enabled` gates its data fetching. */
  useLookup: (enabled: boolean) => SlotFilamentIdentityLookup
}

let registration: SlotFilamentIdentityRegistration | null = null

/**
 * Register the loaded-spool lookup hook. Must be called from a plugin `init`
 * (before the React tree mounts): consumers branch on the registration at
 * render time, so it must not change during a session.
 */
export function registerSlotFilamentIdentityHook(
  pluginName: string,
  useLookup: (enabled: boolean) => SlotFilamentIdentityLookup
): void {
  registration = { pluginName, useLookup }
}

const NULL_LOOKUP: SlotFilamentIdentityLookup = () => null

/**
 * The active loaded-spool lookup for core surfaces. Applies the same
 * plugin-enablement gate as `<PluginSlot />`, so a disabled plugin neither
 * fetches nor labels anything.
 */
export function useSlotFilamentIdentityLookup(): SlotFilamentIdentityLookup {
  const authBootstrapQuery = useAuthBootstrapQuery()
  const pluginStateQuery = usePluginCatalogQuery({
    enabled: authBootstrapQuery.isSuccess
      ? (!authBootstrapQuery.data.authEnabled || authBootstrapQuery.data.actor.type !== 'anonymous')
      : false,
    suppressGlobalErrorToast: true
  })
  const apiPluginsByName = useMemo(
    () => new Map((pluginStateQuery.data?.plugins ?? []).map((plugin) => [plugin.name, plugin] as const)),
    [pluginStateQuery.data?.plugins]
  )
  const active = registration != null
    && isPluginActiveByName(registration.pluginName, apiPluginsByName, pluginStateQuery.data?.plugins != null)
  // Registration is fixed before mount (plugin init), so this branch is
  // render-stable and the conditional hook call is safe.
  const lookup = registration ? registration.useLookup(active) : NULL_LOOKUP
  const manual = useQuery({
    queryKey: workspaceQueryKeys.printerStatus(readCurrentWorkspaceScopeKey()),
    queryFn: () => Promise.resolve<Record<string, PrinterStatus>>({}),
    initialData: {}, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
    select: (statuses: Record<string, PrinterStatus>) => Object.values(statuses).flatMap((status) => [
      ...status.ams.flatMap((unit) => unit.slots.flatMap((slot) => slot.materialIdentity
        ? [{ key: `${status.printerId}:${unit.unitId}:${slot.slot}`, identity: slot.materialIdentity }] : [])),
      ...status.externalSpools.flatMap((slot) => slot.materialIdentity
        ? [{ key: `${status.printerId}:${slot.amsId}:-1`, identity: slot.materialIdentity }] : [])
    ])
  })
  return useMemo(() => {
    const identities = new Map(manual.data?.map((entry) => [entry.key, entry.identity]))
    return (printerId, amsId, slotId) => {
      const identity = identities.get(`${printerId}:${amsId}:${slotId ?? -1}`)
      if (identity) return { ...identity, spoolId: null }
      return active ? lookup(printerId, amsId, slotId) : null
    }
  }, [manual.data, active, lookup])
}
