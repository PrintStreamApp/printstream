/**
 * Model studio viewport preferences: the modelled 3D build plate, and which side the
 * settings/objects panel sits on.
 *
 * Follows the general-settings shape used by theme, layout, and slicer developer mode: a
 * workspace-wide shared default persisted through `/api/settings`
 * (`GeneralSettings.editorShowBedModel` / `.editorSidebarSide`) plus a per-device override kept in
 * browser localStorage. They were device-only before, so a workspace could not set a house default
 * at all. The editor reads the effective values via `lib/editorViewportSettings.ts`.
 *
 * Self-contained like `SlicerDeveloperModeCard`: reads and writes the same `['general-settings']`
 * React Query cache App.tsx owns (so a save here keeps app-wide consumers in sync) and derives
 * edit permission from the cached auth bootstrap. Rendered in the editor settings dialog rather
 * than the Settings page, because that is where these are used — but unlike that dialog's other
 * content they are NOT editor-only state, which is why they live in core settings components.
 */
import { extractErrorMessage, type EditorSidebarSideSetting, type GeneralSettings, type UpdateGeneralSettingsInput } from '@printstream/shared'
import { Alert, Option, Select } from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { apiFetch } from '../../lib/apiClient'
import { useShowBedModelOverride, useSidebarSideOverride } from '../../lib/editorViewportSettings'
import { DeviceOverrideNotice, GeneralSettingCard, GeneralSettingSelectRow } from './GeneralSettingControls'

/** `follow-default` is the absence of a device override, not a third stored value. */
type DeviceChoice<T extends string> = 'follow-default' | T

/** Shared plumbing both cards need: the settings cache, the save mutation, and edit permission. */
function useGeneralSettingsEditor() {
  const queryClient = useQueryClient()
  const canManageSettings = useAuthBootstrapQuery().data?.capabilities?.canManageSettings ?? false
  const query = useQuery({
    queryKey: ['general-settings'],
    queryFn: ({ signal }) => apiFetch<GeneralSettings>('/api/settings', { signal })
  })
  const mutation = useMutation({
    mutationFn: (input: UpdateGeneralSettingsInput) =>
      apiFetch<GeneralSettings>('/api/settings', { method: 'PUT', body: input }),
    onSuccess: (data) => {
      // Keep the app-wide general-settings cache authoritative, matching App.tsx.
      queryClient.setQueryData(['general-settings'], data)
    }
  })
  return {
    canManageSettings,
    settings: query.data,
    save: mutation,
    saveError: mutation.error ? extractErrorMessage(mutation.error) : null
  }
}

export function BuildPlateSettingCard() {
  const { canManageSettings, settings, save, saveError } = useGeneralSettingsEditor()
  const sharedEnabled = settings?.editorShowBedModel ?? true
  const [deviceOverride, setDeviceOverride] = useShowBedModelOverride()
  const deviceValue: DeviceChoice<'on' | 'off'> = deviceOverride == null ? 'follow-default' : deviceOverride ? 'on' : 'off'

  return (
    <GeneralSettingCard
      title="3D build plate"
      description="Show the printer’s modelled build plate instead of the plain grid. Turn it off for a plain grid on every printer, including those with no plate model."
      // Reset means "back to the shipped default" — the plate is on by default, so a shared value
      // of true is already reset.
      resetDisabled={deviceOverride == null && !(canManageSettings && !sharedEnabled)}
      onReset={() => {
        if (canManageSettings) save.mutate({ editorShowBedModel: true })
        setDeviceOverride(null)
      }}
    >
      <GeneralSettingSelectRow label="Default setting" helper="Shared default applied to devices that do not have their own override.">
        <Select<'on' | 'off'>
          value={sharedEnabled ? 'on' : 'off'}
          disabled={!canManageSettings || save.isPending}
          onChange={(_event, value) => { if (value) save.mutate({ editorShowBedModel: value === 'on' }) }}
        >
          <Option value="on">Shown</Option>
          <Option value="off">Hidden</Option>
        </Select>
      </GeneralSettingSelectRow>

      <GeneralSettingSelectRow label="This device" helper="Saved in this browser only. Choose follow default to inherit the shared setting.">
        <Select<DeviceChoice<'on' | 'off'>>
          value={deviceValue}
          onChange={(_event, value) => {
            if (!value) return
            setDeviceOverride(value === 'follow-default' ? null : value === 'on')
          }}
        >
          <Option value="follow-default">Follow default setting</Option>
          <Option value="on">Shown on this device</Option>
          <Option value="off">Hidden on this device</Option>
        </Select>
      </GeneralSettingSelectRow>

      {deviceOverride != null && (
        <DeviceOverrideNotice
          message="This device is currently using its own build-plate preference instead of the shared default."
          onClear={() => setDeviceOverride(null)}
        />
      )}

      {saveError && <Alert color="danger">{saveError}</Alert>}
    </GeneralSettingCard>
  )
}

export function PanelPositionSettingCard() {
  const { canManageSettings, settings, save, saveError } = useGeneralSettingsEditor()
  const sharedSide = settings?.editorSidebarSide ?? 'right'
  const [deviceOverride, setDeviceOverride] = useSidebarSideOverride()
  const deviceValue: DeviceChoice<EditorSidebarSideSetting> = deviceOverride ?? 'follow-default'

  return (
    <GeneralSettingCard
      title="Panel position"
      description="Which side of the 3D view the settings and objects panel sits on. Narrow screens always stack it below the view."
      resetDisabled={deviceOverride == null && !(canManageSettings && sharedSide !== 'right')}
      onReset={() => {
        if (canManageSettings) save.mutate({ editorSidebarSide: 'right' })
        setDeviceOverride(null)
      }}
    >
      <GeneralSettingSelectRow label="Default setting" helper="Shared default applied to devices that do not have their own override.">
        <Select<EditorSidebarSideSetting>
          value={sharedSide}
          disabled={!canManageSettings || save.isPending}
          onChange={(_event, value) => { if (value) save.mutate({ editorSidebarSide: value }) }}
        >
          <Option value="left">Left</Option>
          <Option value="right">Right</Option>
        </Select>
      </GeneralSettingSelectRow>

      <GeneralSettingSelectRow label="This device" helper="Saved in this browser only. Choose follow default to inherit the shared setting.">
        <Select<DeviceChoice<EditorSidebarSideSetting>>
          value={deviceValue}
          onChange={(_event, value) => {
            if (!value) return
            setDeviceOverride(value === 'follow-default' ? null : value)
          }}
        >
          <Option value="follow-default">Follow default setting</Option>
          <Option value="left">Left on this device</Option>
          <Option value="right">Right on this device</Option>
        </Select>
      </GeneralSettingSelectRow>

      {deviceOverride != null && (
        <DeviceOverrideNotice
          message="This device is currently using its own panel position instead of the shared default."
          onClear={() => setDeviceOverride(null)}
        />
      )}

      {saveError && <Alert color="danger">{saveError}</Alert>}
    </GeneralSettingCard>
  )
}
