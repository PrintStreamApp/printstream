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
 * derives edit permission from the cached auth bootstrap. Rendered from
 * `EditorSettingsDialog`, which is NOT gated on `canManageSettings`: the card
 * carries that gate itself: the shared default is read-only without the
 * capability, while the per-device override is a personal preference anyone
 * using the editor may set. The public editor omits it (no workspace to read a
 * shared default from).
 */
import { Alert, Option, Select } from '@mui/joy'
import { useSlicerDeveloperModeOverride } from '../../lib/slicerDeveloperMode'
import { DeviceOverrideNotice, GeneralSettingCard, GeneralSettingSelectRow } from './GeneralSettingControls'
import { useGeneralSettingsEditor } from './useGeneralSettingsEditor'

type SharedValue = 'on' | 'off'
type DeviceValue = 'follow-default' | 'on' | 'off'

export function SlicerDeveloperModeCard() {
  const { canManageSettings, settings, save: updateGeneralSettings, saveError } = useGeneralSettingsEditor()
  const sharedEnabled = settings?.slicerDeveloperMode ?? false
  const [deviceOverride, setDeviceOverride] = useSlicerDeveloperModeOverride()

  const sharedSelectValue: SharedValue = sharedEnabled ? 'on' : 'off'
  const deviceSelectValue: DeviceValue = deviceOverride == null ? 'follow-default' : deviceOverride ? 'on' : 'off'

  return (
    <GeneralSettingCard
      title="Developer slicer settings"
      description="Show advanced slicer options. Incorrect values can cause failed or unsafe prints."
      resetDisabled={deviceOverride == null && !(canManageSettings && sharedEnabled)}
      onReset={() => {
        if (canManageSettings) updateGeneralSettings.mutate({ slicerDeveloperMode: false })
        setDeviceOverride(null)
      }}
    >
      <GeneralSettingSelectRow label="Default setting">
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

      <GeneralSettingSelectRow label="This device">
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
