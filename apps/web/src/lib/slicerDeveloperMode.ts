/**
 * Client access to the "developer slicer settings" preference: whether the
 * process-settings editor reveals BambuStudio's developer-mode (`develop`-tier)
 * options.
 *
 * Mirrors the general-settings shape (theme, landing page): a **workspace-wide
 * shared default** persisted server-side in `GeneralSettings.slicerDeveloperMode`
 * (via `/api/settings`, tenant-scoped) plus an optional **per-device override**
 * in browser localStorage. The effective value is `override ?? sharedDefault`.
 *
 * Read consumers (the process-settings editor `ProcessSettingsDialog`) use
 * `useEffectiveSlicerDeveloperMode`; the Slicing settings toggle
 * (`SlicerDeveloperModeCard`) edits the shared default and the device override
 * separately. The shared value is read from the same `['general-settings']`
 * React Query cache App.tsx owns, so this adds no extra fetch.
 *
 * Default off: developer-tier options are the ones BambuStudio keeps hidden
 * because they are easy to misuse.
 */
import { useQuery } from '@tanstack/react-query'
import type { GeneralSettings } from '@printstream/shared'
import { DEVICE_SLICER_DEVELOPER_MODE_OVERRIDE_KEY } from '../appShellHelpers'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { apiFetch } from './apiClient'

function parseNullableBoolean(raw: string): boolean | null {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function serializeNullableBoolean(value: boolean | null): string {
  return value === null ? 'null' : String(value)
}

/**
 * The per-device override: `true`/`false` shadow the shared default on this
 * browser, `null` means "follow the workspace default".
 */
export function useSlicerDeveloperModeOverride(): [boolean | null, (value: boolean | null) => void] {
  const [value, setValue] = useLocalStorageState<boolean | null>(
    DEVICE_SLICER_DEVELOPER_MODE_OVERRIDE_KEY,
    null,
    parseNullableBoolean,
    serializeNullableBoolean
  )
  return [value, setValue]
}

/** The workspace-wide shared default from cached general settings (false until loaded). */
export function useSharedSlicerDeveloperMode(): boolean {
  const { data } = useQuery({
    queryKey: ['general-settings'],
    queryFn: ({ signal }) => apiFetch<GeneralSettings>('/api/settings', { signal })
  })
  return data?.slicerDeveloperMode ?? false
}

/** Effective flag the editor honours: the device override if set, else the shared default. */
export function useEffectiveSlicerDeveloperMode(): boolean {
  const [override] = useSlicerDeveloperModeOverride()
  const shared = useSharedSlicerDeveloperMode()
  return override ?? shared
}
