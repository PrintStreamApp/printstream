/**
 * Client access to the model studio's viewport preferences: the modelled 3D build plate and which
 * side the settings/objects panel sits on.
 *
 * Mirrors the general-settings shape used by theme, landing page, and slicer developer mode: a
 * **workspace-wide shared default** persisted server-side in `GeneralSettings`
 * (`editorShowBedModel` / `editorSidebarSide`, via `/api/settings`, workspace-scoped) plus an optional
 * **per-device override** in browser localStorage. The effective value is `override ?? sharedDefault`.
 *
 * Both tiers matter here: a workspace can set the house layout while one machine still differs — a
 * left-handed panel, or a weak GPU that skips the modelled plate. Before this, these were
 * device-only, so a workspace had no way to set a default at all.
 *
 * Read consumers (the editor and the read-only previews) use the `useEffective*` hooks; the
 * viewport tab of `components/library/EditorSettingsDialog.tsx` edits the shared default and the
 * device override separately. The shared value comes from the same `['general-settings']` React
 * Query cache App.tsx owns, so this adds no extra fetch.
 *
 * Both tiers are **per workspace**. The shared default already is (`/api/settings` is
 * workspace-scoped), and the device override is keyed by workspace slug to match: each workspace sets
 * its own default, so an override shared across workspaces would silently shadow a default it was
 * never chosen against. This mirrors the nav-order and landing-page overrides.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { EditorSidebarSideSetting, GeneralSettings } from '@printstream/shared'
import { DEVICE_EDITOR_SHOW_BED_MODEL_OVERRIDE_KEY_PREFIX, DEVICE_EDITOR_SIDEBAR_SIDE_OVERRIDE_KEY_PREFIX } from '../appShellHelpers'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { useAuthBootstrapQuery } from './authQuery'
import { apiFetch } from './apiClient'

/**
 * Marks a host that has no workspace behind it — the public editor, where a file comes from the
 * user's disk and there is no workspace, no `/api/settings`, and nobody to set a house default.
 *
 * The two-tier model is meaningless there: "workspace default vs this device" collapses to just
 * "this device". Under this scope the shared query never runs (it would 401), the effective value is
 * the device override or the shipped default, and the settings UI shows one tier instead of two.
 */
const ViewportSettingsScopeContext = createContext<{ deviceOnly: boolean }>({ deviceOnly: false })

export function ViewportSettingsScopeProvider({ deviceOnly, children }: { deviceOnly: boolean; children: ReactNode }) {
  return createElement(ViewportSettingsScopeContext.Provider, { value: { deviceOnly } }, children)
}

/** Whether the current host has a workspace tier at all. */
export function useViewportSettingsDeviceOnly(): boolean {
  return useContext(ViewportSettingsScopeContext).deviceOnly
}

/** Fallbacks used until general settings load, matching the schema defaults. */
const SHOW_BED_MODEL_DEFAULT = true
const SIDEBAR_SIDE_DEFAULT: EditorSidebarSideSetting = 'right'

function parseNullableBoolean(raw: string): boolean | null {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function serializeNullable(value: boolean | EditorSidebarSideSetting | null): string {
  return value === null ? 'null' : String(value)
}

function parseNullableSide(raw: string): EditorSidebarSideSetting | null {
  return raw === 'left' || raw === 'right' ? raw : null
}

/**
 * Suffix scoping a device override to the workspace whose default it shadows. Falls back to
 * `ambient` outside a workspace, matching how App.tsx keys its own per-device overrides.
 */
function useWorkspaceKeySuffix(): string {
  const deviceOnly = useViewportSettingsDeviceOnly()
  const slug = useAuthBootstrapQuery().data?.workspace?.slug
  // A server-less host keys on its own name rather than `ambient`: it is not "signed in without a
  // workspace", it is a different surface, and sharing a key would let one shadow the other.
  if (deviceOnly) return 'local'
  return slug ?? 'ambient'
}

/** The cached shared settings both defaults come from; one query, shared by every hook here. */
function useSharedGeneralSettings(): GeneralSettings | undefined {
  const deviceOnly = useViewportSettingsDeviceOnly()
  return useQuery({
    queryKey: ['general-settings'],
    queryFn: ({ signal }) => apiFetch<GeneralSettings>('/api/settings', { signal }),
    // No workspace means no shared settings to fetch; the request would only 401.
    enabled: !deviceOnly
  }).data
}

/**
 * The per-device 3D-plate override: `true`/`false` shadow the shared default on this browser,
 * `null` means "follow the workspace default".
 */
export function useShowBedModelOverride(): [boolean | null, (value: boolean | null) => void] {
  const workspace = useWorkspaceKeySuffix()
  const [value, setValue] = useLocalStorageState<boolean | null>(
    `${DEVICE_EDITOR_SHOW_BED_MODEL_OVERRIDE_KEY_PREFIX}.${workspace}`,
    null,
    parseNullableBoolean,
    serializeNullable
  )
  return [value, setValue]
}

/** Sibling of {@link useShowBedModelOverride} for the panel side. */
export function useSidebarSideOverride(): [EditorSidebarSideSetting | null, (value: EditorSidebarSideSetting | null) => void] {
  const workspace = useWorkspaceKeySuffix()
  const [value, setValue] = useLocalStorageState<EditorSidebarSideSetting | null>(
    `${DEVICE_EDITOR_SIDEBAR_SIDE_OVERRIDE_KEY_PREFIX}.${workspace}`,
    null,
    parseNullableSide,
    serializeNullable
  )
  return [value, setValue]
}

/** The workspace-wide shared defaults from cached general settings. */
export function useSharedShowBedModel(): boolean {
  return useSharedGeneralSettings()?.editorShowBedModel ?? SHOW_BED_MODEL_DEFAULT
}

export function useSharedSidebarSide(): EditorSidebarSideSetting {
  return useSharedGeneralSettings()?.editorSidebarSide ?? SIDEBAR_SIDE_DEFAULT
}

/** Effective values the viewport honours: the device override if set, else the shared default. */
export function useEffectiveShowBedModel(): boolean {
  const [override] = useShowBedModelOverride()
  const shared = useSharedShowBedModel()
  return override ?? shared
}

export function useEffectiveSidebarSide(): EditorSidebarSideSetting {
  const [override] = useSidebarSideOverride()
  const shared = useSharedSidebarSide()
  return override ?? shared
}
