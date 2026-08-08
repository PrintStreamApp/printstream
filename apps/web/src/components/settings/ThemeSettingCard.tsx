/**
 * The Theme picker card: a shared default (persisted through /api/settings
 * in the caller's scope — workspace or platform) plus a browser-local
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
  sharedScopeLabel = 'everyone here',
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
  /**
   * Who the SHARED default is shared with, named by the host.
   *
   * The card is rendered in three scopes and the row said only "shared
   * default", which answers device-vs-shared and not shared-with-whom. Someone
   * changing it in one workspace could not tell whether they had just restyled
   * their team, every workspace, or the whole deployment.
   */
  sharedScopeLabel?: string
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
      resetDisabled={deviceAppThemeOverride == null && !(hasSharedSetting && canManageSettings && sharedAppTheme !== 'default')}
      onReset={() => {
        if (hasSharedSetting && canManageSettings) onSetSharedAppTheme('default')
        onClearDeviceAppThemeOverride()
      }}
    >
      {hasSharedSetting ? (
      <GeneralSettingSelectRow
        label="Default setting"
        helper={`Shared with ${sharedScopeLabel}, and applied to devices that do not have their own override.`}
      >
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

      <GeneralSettingSelectRow
        label="This device"
        helper={hasSharedSetting
          ? 'Saved in this browser only, and applies wherever you go in the app on it. Choose follow default to inherit the shared setting.'
          : 'Saved in this browser only. Nobody else on the account sees this choice.'}
      >
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
