/**
 * The Theme picker card: a shared default (persisted through /api/settings
 * in the caller's scope — tenant or platform) plus a browser-local
 * per-device override. Rendered by both the workspace Settings view and the
 * Platform workspace so the two surfaces stay identical; each passes its own
 * scope's values and override handlers.
 */
import { Option, Select } from '@mui/joy'
import type { AppThemeSetting } from '@printstream/shared'
import { appThemeOptions } from '../../theme/flatThemes'
import { DeviceOverrideNotice, GeneralSettingCard, GeneralSettingSelectRow } from './GeneralSettingControls'

type DeviceThemeSettingSelectValue = 'follow-default' | AppThemeSetting

export function ThemeSettingCard({
  sharedAppTheme,
  deviceAppThemeOverride,
  canManageSettings,
  sharedSettingsSaving,
  onSetSharedAppTheme,
  onSetDeviceAppTheme,
  onClearDeviceAppThemeOverride
}: {
  sharedAppTheme: AppThemeSetting
  deviceAppThemeOverride: AppThemeSetting | null
  canManageSettings: boolean
  sharedSettingsSaving: boolean
  onSetSharedAppTheme: (value: AppThemeSetting) => void
  onSetDeviceAppTheme: (value: AppThemeSetting) => void
  onClearDeviceAppThemeOverride: () => void
}) {
  const deviceThemeSelectValue: DeviceThemeSettingSelectValue = deviceAppThemeOverride ?? 'follow-default'

  return (
    <GeneralSettingCard
      title="Theme"
      description="Choose the app's appearance: the default look, the Aurora background treatment, or one of the flat styles (Graphite accents, Slate, Code Dark)."
      resetDisabled={deviceAppThemeOverride == null && !(canManageSettings && sharedAppTheme !== 'default')}
      onReset={() => {
        if (canManageSettings) onSetSharedAppTheme('default')
        onClearDeviceAppThemeOverride()
      }}
    >
      <GeneralSettingSelectRow label="Default setting" helper="Shared default applied to devices that do not have their own override.">
        <Select<AppThemeSetting>
          value={sharedAppTheme}
          disabled={sharedSettingsSaving}
          onChange={(_event, value) => {
            if (!value) return
            onSetSharedAppTheme(value)
          }}
        >
          {appThemeOptions.map((option) => (
            <Option key={option.value} value={option.value}>{option.label} theme</Option>
          ))}
        </Select>
      </GeneralSettingSelectRow>

      <GeneralSettingSelectRow label="This device" helper="Saved in this browser only. Choose follow default to inherit the shared setting.">
        <Select<DeviceThemeSettingSelectValue>
          value={deviceThemeSelectValue}
          onChange={(_event, value) => {
            if (!value) return
            if (value === 'follow-default') {
              onClearDeviceAppThemeOverride()
              return
            }
            onSetDeviceAppTheme(value)
          }}
        >
          <Option value="follow-default">Follow default setting</Option>
          {appThemeOptions.map((option) => (
            <Option key={option.value} value={option.value}>{option.label} theme on this device</Option>
          ))}
        </Select>
      </GeneralSettingSelectRow>

      {deviceAppThemeOverride != null && (
        <DeviceOverrideNotice
          message="This device is currently using its own theme setting instead of the shared default."
          onClear={onClearDeviceAppThemeOverride}
        />
      )}
    </GeneralSettingCard>
  )
}
