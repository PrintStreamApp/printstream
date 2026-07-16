/**
 * Slicing settings control for BambuStudio's developer-mode (`develop`-tier)
 * slicer options in the process-settings editor.
 *
 * Follows the general-settings shape (theme, layout): a workspace-wide shared
 * default persisted through `/api/settings` (`GeneralSettings.slicerDeveloperMode`)
 * plus a per-device override kept in browser localStorage. The editor
 * (`ProcessSettingsDialog`) reads the effective value via
 * `useEffectiveSlicerDeveloperMode`.
 *
 * Self-contained: it reads/writes the same `['general-settings']` React Query
 * cache App.tsx owns (so a save here keeps the app-wide consumers in sync) and
 * derives edit permission from the cached auth bootstrap. Rendered only in the
 * Slicing settings subview, which is already gated on `canManageSettings`.
 */
import { extractErrorMessage, type GeneralSettings, type UpdateGeneralSettingsInput } from '@printstream/shared'
import { Alert, Option, Select } from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { apiFetch } from '../../lib/apiClient'
import { useSlicerDeveloperModeOverride } from '../../lib/slicerDeveloperMode'
import { DeviceOverrideNotice, GeneralSettingCard, GeneralSettingSelectRow } from './GeneralSettingControls'

type SharedValue = 'on' | 'off'
type DeviceValue = 'follow-default' | 'on' | 'off'

export function SlicerDeveloperModeCard() {
  const queryClient = useQueryClient()
  const canManageSettings = useAuthBootstrapQuery().data?.capabilities?.canManageSettings ?? false
  const generalSettingsQuery = useQuery({
    queryKey: ['general-settings'],
    queryFn: ({ signal }) => apiFetch<GeneralSettings>('/api/settings', { signal })
  })
  const sharedEnabled = generalSettingsQuery.data?.slicerDeveloperMode ?? false
  const [deviceOverride, setDeviceOverride] = useSlicerDeveloperModeOverride()

  const updateGeneralSettings = useMutation({
    mutationFn: (input: UpdateGeneralSettingsInput) =>
      apiFetch<GeneralSettings>('/api/settings', { method: 'PUT', body: input }),
    onSuccess: (data) => {
      // Keep the app-wide general-settings cache authoritative, matching App.tsx.
      queryClient.setQueryData(['general-settings'], data)
    }
  })
  const saveError = updateGeneralSettings.error ? extractErrorMessage(updateGeneralSettings.error) : null

  const sharedSelectValue: SharedValue = sharedEnabled ? 'on' : 'off'
  const deviceSelectValue: DeviceValue = deviceOverride == null ? 'follow-default' : deviceOverride ? 'on' : 'off'

  return (
    <GeneralSettingCard
      title="Developer slicer settings"
      description="Show BambuStudio's developer-mode options in the quality/process settings editor. These advanced options are hidden by default because incorrect values can produce failed or unsafe prints."
      resetDisabled={deviceOverride == null && !(canManageSettings && sharedEnabled)}
      onReset={() => {
        if (canManageSettings) updateGeneralSettings.mutate({ slicerDeveloperMode: false })
        setDeviceOverride(null)
      }}
    >
      <GeneralSettingSelectRow label="Default setting" helper="Shared default applied to devices that do not have their own override.">
        <Select<SharedValue>
          value={sharedSelectValue}
          disabled={!canManageSettings || updateGeneralSettings.isPending}
          onChange={(_event, value) => {
            if (!value) return
            updateGeneralSettings.mutate({ slicerDeveloperMode: value === 'on' })
          }}
        >
          <Option value="off">Hidden</Option>
          <Option value="on">Shown</Option>
        </Select>
      </GeneralSettingSelectRow>

      <GeneralSettingSelectRow label="This device" helper="Saved in this browser only. Choose follow default to inherit the shared setting.">
        <Select<DeviceValue>
          value={deviceSelectValue}
          onChange={(_event, value) => {
            if (!value) return
            if (value === 'follow-default') {
              setDeviceOverride(null)
              return
            }
            setDeviceOverride(value === 'on')
          }}
        >
          <Option value="follow-default">Follow default setting</Option>
          <Option value="off">Hidden on this device</Option>
          <Option value="on">Shown on this device</Option>
        </Select>
      </GeneralSettingSelectRow>

      {deviceOverride != null && (
        <DeviceOverrideNotice
          message="This device is currently using its own developer-settings preference instead of the shared default."
          onClear={() => setDeviceOverride(null)}
        />
      )}

      {saveError && <Alert color="danger">{saveError}</Alert>}
    </GeneralSettingCard>
  )
}
