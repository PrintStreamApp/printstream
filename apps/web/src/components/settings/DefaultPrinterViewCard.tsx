/**
 * Two-tier control for the printers dashboard's default view, which view the
 * bare `/printers` address opens with: a workspace-wide shared default
 * (`GeneralSettings.printersDefaultViewId`, editable with manage-settings) and
 * a per-device override anyone may set (`lib/printerViewDefaults.ts`).
 *
 * Follows the general-settings card shape (`EditorViewportSettingsCards`,
 * `SlicerDeveloperModeCard`): self-contained, rendered from the printers View
 * settings dialog rather than the Settings page because that is where views are
 * managed, but the workspace tier is not dialog-local state, which is why it
 * lives in core settings components.
 */
import { Alert, Option, Select } from '@mui/joy'
import { OVERVIEW_VIEW_LABEL } from '../../lib/printersViewHelpers'
import { useDefaultPrinterViewOverride } from '../../lib/printerViewDefaults'
import { OVERVIEW_VIEW_ROUTE_ID } from '../../lib/printerViewRoutes'
import { usePrinterViewsQuery } from '../../lib/printerViewsQuery'
import { DeviceOverrideNotice, GeneralSettingCard, GeneralSettingSelectRow } from './GeneralSettingControls'
import { useGeneralSettingsEditor } from './useGeneralSettingsEditor'

/**
 * Select values: the `overview` sentinel stands in for `null` on the shared
 * tier (a Select value must be a string), and doubles as the real stored
 * "Overview on this device" override value.
 */
type SharedValue = string
type DeviceValue = 'follow-default' | string

export function DefaultPrinterViewCard() {
  const { canManageSettings, settings, save, saveError } = useGeneralSettingsEditor()
  const views = usePrinterViewsQuery(true).data?.views ?? []
  const [deviceOverride, setDeviceOverride] = useDefaultPrinterViewOverride()

  const viewExists = (id: string | null): id is string => id != null && views.some((view) => view.id === id)
  const sharedDefaultViewId = settings?.printersDefaultViewId ?? null
  // A stored id whose view was deleted elsewhere reads as Overview, matching
  // how the dashboard resolves it.
  const sharedSelectValue: SharedValue = viewExists(sharedDefaultViewId) ? sharedDefaultViewId : OVERVIEW_VIEW_ROUTE_ID
  const deviceSelectValue: DeviceValue = deviceOverride == null
    ? 'follow-default'
    : deviceOverride === OVERVIEW_VIEW_ROUTE_ID || viewExists(deviceOverride)
      ? deviceOverride
      : 'follow-default'

  return (
    <GeneralSettingCard
      title="Default view"
      description="Which view the Printers page opens with. Every view also keeps its own address for bookmarking."
      resetDisabled={deviceOverride == null && !(canManageSettings && sharedDefaultViewId != null)}
      onReset={() => {
        if (canManageSettings) save.mutate({ printersDefaultViewId: null })
        setDeviceOverride(null)
      }}
    >
      <GeneralSettingSelectRow label="Default setting" helper="Shared with everyone in this workspace, and applied to devices that do not have their own override.">
        <Select<SharedValue>
          value={sharedSelectValue}
          disabled={!canManageSettings || save.isPending}
          onChange={(_event, value) => {
            // `null` here is the Select clearing a value whose Option is not
            // mounted (e.g. views still loading), never a user pick.
            if (!value) return
            save.mutate({ printersDefaultViewId: value === OVERVIEW_VIEW_ROUTE_ID ? null : value })
          }}
        >
          <Option value={OVERVIEW_VIEW_ROUTE_ID}>{OVERVIEW_VIEW_LABEL}</Option>
          {views.map((view) => (
            <Option key={view.id} value={view.id}>{view.name}</Option>
          ))}
        </Select>
      </GeneralSettingSelectRow>

      <GeneralSettingSelectRow label="This device" helper="Saved in this browser, for this workspace only. Choose follow default to inherit the shared setting.">
        <Select<DeviceValue>
          value={deviceSelectValue}
          onChange={(_event, value) => {
            if (!value) return
            setDeviceOverride(value === 'follow-default' ? null : value)
          }}
        >
          <Option value="follow-default">Follow default setting</Option>
          <Option value={OVERVIEW_VIEW_ROUTE_ID}>{OVERVIEW_VIEW_LABEL} on this device</Option>
          {views.map((view) => (
            <Option key={view.id} value={view.id}>{view.name} on this device</Option>
          ))}
        </Select>
      </GeneralSettingSelectRow>

      {deviceOverride != null && (
        <DeviceOverrideNotice
          message="This device is currently opening its own view instead of the shared default."
          onClear={() => setDeviceOverride(null)}
        />
      )}

      {saveError && <Alert color="danger">{saveError}</Alert>}
    </GeneralSettingCard>
  )
}
