/**
 * The Theme picker card: a shared default (persisted through /api/settings
 * in the caller's scope: workspace or platform) plus a browser-local
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
  hasSharedSetting = true,
  sharedAppTheme,
  deviceAppThemeOverride,
  canManageSettings,
  sharedSettingsSaving,
  onSetSharedAppTheme,
  onSetDeviceAppTheme,
  onClearDeviceAppThemeOverride
}: {
  /**
   * Whether a shared default exists in this scope at all.
   *
   * False in the billing scope, which has no server-side setting behind it. The
   * row used to render regardless -- an interactive select wired to a handler
   * that did nothing, which is worse than no control.
   */
  hasSharedSetting?: boolean
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
      description="Choose the app's appearance."
      resetDisabled={deviceAppThemeOverride == null && !(hasSharedSetting && canManageSettings && sharedAppTheme !== 'default')}
      onReset={() => {
        if (hasSharedSetting && canManageSettings) onSetSharedAppTheme('default')
        onClearDeviceAppThemeOverride()
      }}
    >
      {hasSharedSetting ? (
      <GeneralSettingSelectRow label="Default setting">
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
      ) : null}

      <GeneralSettingSelectRow label="This device">
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
