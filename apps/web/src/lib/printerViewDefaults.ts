/**
 * The printers dashboard's default view, which view the bare `/printers`
 * address opens with. Two tiers, mirroring `editorViewportSettings.ts`: a
 * **workspace-wide shared default** persisted server-side
 * (`GeneralSettings.printersDefaultViewId`, via `/api/settings`) and a
 * **per-device override** in browser localStorage. The effective value is
 * `override ?? sharedDefault`, with `null` meaning the built-in Overview.
 *
 * The device tier keeps the pre-two-tier storage key (it used to be the ONLY
 * tier, labelled just "Set as default"), so existing devices keep the default
 * they chose: reinterpreted as an override now that a workspace default
 * exists underneath it. Its value space grew one member: the stored string is
 * a view id, the reserved `overview` sentinel (`OVERVIEW_VIEW_ROUTE_ID`, it
 * cannot collide with a cuid) pins the Overview on this device even when the
 * workspace default is a view, and `null`/absent means "follow the workspace
 * default". Old stored values are plain view ids, which parse unchanged.
 *
 * Edited by `components/settings/DefaultPrinterViewCard.tsx` (rendered in the
 * printers View settings dialog); `pages/PrintersView.tsx` reads the effective
 * id and clears a device override whose view no longer exists. A stale SHARED
 * id is read as Overview here and cleared server-side when its view is deleted.
 */
import type { GeneralSettings } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { apiFetch } from './apiClient'
import { OVERVIEW_VIEW_ROUTE_ID } from './printerViewRoutes'
import { useWorkspacePreferenceScopeKey } from './workspacePreferenceScope'

/** A view id, `OVERVIEW_VIEW_ROUTE_ID`, or `null` = follow the workspace default. */
export type PrinterViewDefaultOverride = string | null

function parseStoredOverride(raw: string): PrinterViewDefaultOverride {
  const value = raw.trim()
  return value && value !== 'null' ? value : null
}

function serializeStoredOverride(value: PrinterViewDefaultOverride): string {
  return value ?? ''
}

/** The per-device tier: this browser's default-view choice for the workspace. */
export function useDefaultPrinterViewOverride(): [PrinterViewDefaultOverride, (value: PrinterViewDefaultOverride) => void] {
  const scopeKey = useWorkspacePreferenceScopeKey()
  const [value, setValue] = useLocalStorageState<PrinterViewDefaultOverride>(
    `bambu.printers.defaultViewId.${scopeKey}`,
    null,
    parseStoredOverride,
    serializeStoredOverride
  )
  return [value, setValue]
}

/** The workspace-wide shared default from the cached general settings (`null` = Overview). */
export function useSharedDefaultPrinterViewId(): string | null {
  return useQuery({
    queryKey: ['general-settings'],
    queryFn: ({ signal }) => apiFetch<GeneralSettings>('/api/settings', { signal })
  }).data?.printersDefaultViewId ?? null
}

/**
 * The view id the bare `/printers` address should open (`null` = Overview).
 *
 * A device override wins outright: a view id (if it still exists), or the
 * `overview` sentinel pinning the Overview. A stale override falls through to
 * the shared tier rather than to Overview: the dashboard clears it shortly
 * after anyway, and falling through matches what that clear will produce. A
 * stale shared id degrades to Overview; nothing here writes the shared tier.
 */
export function resolveEffectiveDefaultPrinterViewId(input: {
  override: PrinterViewDefaultOverride
  sharedDefaultViewId: string | null
  views: ReadonlyArray<{ id: string }>
}): string | null {
  const exists = (id: string) => input.views.some((view) => view.id === id)
  if (input.override === OVERVIEW_VIEW_ROUTE_ID) return null
  if (input.override != null && exists(input.override)) return input.override
  if (input.sharedDefaultViewId != null && exists(input.sharedDefaultViewId)) return input.sharedDefaultViewId
  return null
}
