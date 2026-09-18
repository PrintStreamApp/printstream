import React from 'react'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import { Alert, Card, FormLabel, Option, Select, Stack, Typography } from '@mui/joy'
import {
  type AppLandingPageSetting,
  type AppThemeSetting,
  DEFAULT_APP_LANDING_PAGE,
  extractErrorMessage,
  type AuthManagementStatus
} from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { AuthAccessSection } from '../components/AuthAccessSection'
import { pageSectionStackSpacing } from '../components/dashboard/PageSectionHeading'
import { NestedViewHeader } from '../components/NestedViewHeader'
import { NotificationChannelsPanel } from '../components/NotificationChannelsPanel'
import { NotificationTemplatesPanel } from '../components/NotificationTemplatesPanel'
import { NativeAppSettingsButton } from '../native/NativeAppSettingsButton'
import { BridgeSettingsSection } from '../components/settings/BridgeManagementSection'
import { ServerBackupsSection } from '../components/settings/ServerBackupsSection'
import { NavTabOrderEditor } from '../components/settings/NavTabOrderEditor'
import { PluginManagerSection } from '../components/PluginManagerSection'
import { apiFetch } from '../lib/apiClient'
import { authQueryKeys, resolveAuthScope, useAuthBootstrapQuery } from '../lib/authQuery'
import { CORE_LANDING_PAGE_OPTIONS, withPrinterViewLandingPageOptions, type LandingPageOption } from '../lib/landingPageOptions'
import { isPrinterViewPath } from '../lib/printerViewRoutes'
import { usePrinterViewsQuery } from '../lib/printerViewsQuery'
import { DeviceOverrideNotice, GeneralSettingCard, GeneralSettingSelectRow } from '../components/settings/GeneralSettingControls'
import { ThemeSettingCard } from '../components/settings/ThemeSettingCard'
import { resolveSettingsAuthState } from '../lib/settingsAuth'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { buildWorkspacePath, parseWorkspacePathname } from '../lib/workspaceRoute'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { LicenseSettingsSection } from './LicenseSettingsSection'
import { SlicingPresetsSettingsSection } from '../components/settings/slicing-presets/SlicingPresetsSection'
import { SlicerEngineVisibilityCard } from './SlicerEngineVisibilityCard'
import { SlicerEnginesSection } from './SlicerEnginesSection'
import { LogsPanel } from './LogsView'

type LandingPageSettingSelectValue = AppLandingPageSetting
type DeviceLandingPageSettingSelectValue = 'follow-default' | LandingPageSettingSelectValue
type WidthSettingSelectValue = 'centered' | 'full-width'
type DeviceWidthSettingSelectValue = 'follow-default' | WidthSettingSelectValue
type SettingsSubview = 'root' | 'general' | 'authentication' | 'plugins' | 'notifications' | 'logs' | 'bridges' | 'slicing' | 'backups' | 'auth-users' | 'auth-roles'

/**
 * Settings shell. Uses a card index on the root route and dedicated
 * subviews for each settings area to avoid nested accordion chrome.
 */
export function SettingsView({
  sharedAppTheme,
  sharedUnconstrainedWidth,
  sharedLandingPage,
  deviceAppThemeOverride,
  deviceUnconstrainedWidthOverride,
  deviceLandingPageOverride,
  landingPageOptions = CORE_LANDING_PAGE_OPTIONS,
  sharedSettingsError,
  sharedSettingsSaving,
  sharedSettingsSaveError,
  onSetDeviceAppTheme,
  onClearDeviceAppThemeOverride,
  onSetDeviceUnconstrainedWidth,
  onClearDeviceUnconstrainedWidthOverride,
  onSetDeviceLandingPage,
  onClearDeviceLandingPageOverride,
  onSetSharedAppTheme,
  onSetSharedUnconstrainedWidth,
  onSetSharedLandingPage,
  navTabOptions = [],
  sharedNavTabOrder = [],
  deviceNavTabOrder = null,
  onSetSharedNavTabOrder,
  onSetDeviceNavTabOrder,
  onClearDeviceNavTabOrderOverride
}: {
  sharedAppTheme: AppThemeSetting
  sharedUnconstrainedWidth: boolean
  sharedLandingPage: AppLandingPageSetting
  deviceAppThemeOverride: AppThemeSetting | null
  deviceUnconstrainedWidthOverride: boolean | null
  deviceLandingPageOverride: AppLandingPageSetting | null
  landingPageOptions?: ReadonlyArray<LandingPageOption>
  sharedSettingsError: string | null
  sharedSettingsSaving: boolean
  sharedSettingsSaveError: string | null
  onSetDeviceAppTheme: (value: AppThemeSetting) => void
  onClearDeviceAppThemeOverride: () => void
  onSetDeviceUnconstrainedWidth: (value: boolean) => void
  onClearDeviceUnconstrainedWidthOverride: () => void
  onSetDeviceLandingPage: (value: AppLandingPageSetting) => void
  onClearDeviceLandingPageOverride: () => void
  onSetSharedAppTheme: (value: AppThemeSetting) => void
  onSetSharedUnconstrainedWidth: (value: boolean) => void
  onSetSharedLandingPage: (value: AppLandingPageSetting) => void
  /** The reorderable nav tabs (value + label), used to render the order editors. */
  navTabOptions?: ReadonlyArray<{ value: string; label: string }>
  sharedNavTabOrder?: ReadonlyArray<string>
  deviceNavTabOrder?: ReadonlyArray<string> | null
  onSetSharedNavTabOrder?: (order: string[]) => void
  onSetDeviceNavTabOrder?: (order: string[]) => void
  onClearDeviceNavTabOrderOverride?: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const { authWorkspaceId, authScopeKey } = resolveAuthScope(authBootstrapQuery.data)
  const authState = authBootstrapQuery.data
    ? resolveSettingsAuthState(authBootstrapQuery.data)
    : null
  const bootstrapCapabilities = authBootstrapQuery.data?.capabilities
  const authProviders = authState?.authProviders ?? []
  const showsAuthSetup = authState?.showsAuthSetup ?? false
  const canViewAuth = authState?.canViewAuth ?? false
  const canManageAuthProviders = authState?.canManageAuthProviders ?? false
  const canManageSettings = bootstrapCapabilities?.canManageSettings ?? false
  const canManageSupportAccess = bootstrapCapabilities?.canManageSupportAccess ?? false
  const showsAuthenticationSection = authState?.showsAuthenticationSection ?? false
  const hasWorkspaceContext = authBootstrapQuery.data?.workspace != null
  const platformAuthEnabled = authBootstrapQuery.data?.platformAuthEnabled ?? false
  const demoSettingsLocked = authBootstrapQuery.data?.workspace?.slug === 'demo'
  // Managed-bridge installs own a single bundled bridge the operator never
  // manages, so the entire Bridges surface is hidden.
  const { managedBridge, selfHosted } = useRuntimePolicy()
  // Self-hosted (OSS) is a single-workspace install with no platform auth step,
  // so the workspace configures its own sign-in directly; the cloud gates the
  // workspace section on platform auth existing first.
  const showsWorkspaceAuthenticationSection = hasWorkspaceContext
    && showsAuthenticationSection && (platformAuthEnabled || selfHosted)
  const showsWorkspacePluginManager = hasWorkspaceContext && canManageSettings
  const showsWorkspaceNotifications = hasWorkspaceContext && canManageSettings
  const showsWorkspaceLogs = hasWorkspaceContext && canManageSettings
  const showsWorkspaceBridges = hasWorkspaceContext && canManageSettings && !managedBridge
  // Shown everywhere, unlike before. INSTALLING an engine is still self-hosted
  // only: the slicer is shared, so one tenant's removal would break another's
  // slicing, and the API refuses it there. But choosing which engines this
  // workspace SHOWS is a per-workspace preference that matters most on the
  // hosted plan, where every version is installed and most workspaces want one.
  const showsSlicerEngines = hasWorkspaceContext && canManageSettings
  // Whole-install backups exist on self-hosted deployments only; the cloud has
  // operator-level backups and the API 404s the surface there.
  const showsServerBackups = hasWorkspaceContext && canManageSettings && selfHosted
  const workspacePath = parseWorkspacePathname(location.pathname)
  const currentSubview = resolveSettingsSubview(workspacePath.appPathname)
  const settingsPath = (path = '/settings') => workspacePath.workspaceSlug
    ? buildWorkspacePath(workspacePath.workspaceSlug, path)
    : path
  const visibleSubview = resolveVisibleWorkspaceSettingsSubview(currentSubview, {
    showsWorkspaceAuthenticationSection,
    showsWorkspacePluginManager,
    showsWorkspaceNotifications,
    showsWorkspaceLogs,
    showsWorkspaceBridges,
    showsSlicerEngines,
    showsServerBackups,
    canViewAuth
  })
  const authManagementStatusQuery = useQuery({
    queryKey: authQueryKeys.managementStatus(authScopeKey),
    queryFn: () => apiFetch<AuthManagementStatus>('/api/auth/status'),
    enabled: canViewAuth
  })
  const authManagementStatusError = authManagementStatusQuery.error
    ? extractErrorMessage(authManagementStatusQuery.error)
    : null
  const sharedLandingPageSelectValue: LandingPageSettingSelectValue = sharedLandingPage
  const deviceLandingPageSelectValue: DeviceLandingPageSettingSelectValue = deviceLandingPageOverride ?? 'follow-default'
  const sharedWidthSelectValue: WidthSettingSelectValue = sharedUnconstrainedWidth ? 'full-width' : 'centered'
  const deviceWidthSelectValue: DeviceWidthSettingSelectValue = deviceUnconstrainedWidthOverride == null
    ? 'follow-default'
    : deviceUnconstrainedWidthOverride
      ? 'full-width'
      : 'centered'
  // Saved printer views are offered as landing targets alongside the core
  // pages. Fetched only while the General section is open: the rest of the
  // settings shell has no use for the list.
  const printerViewsQuery = usePrinterViewsQuery(visibleSubview === 'general' && hasWorkspaceContext)
  const landingPageOptionsWithViews = React.useMemo(
    () => withPrinterViewLandingPageOptions(landingPageOptions, printerViewsQuery.data?.views ?? []),
    [landingPageOptions, printerViewsQuery.data]
  )
  const resolvedLandingPageOptions = React.useMemo(
    () => ensureLandingPageOptions(landingPageOptionsWithViews, [sharedLandingPage, deviceLandingPageOverride]),
    [deviceLandingPageOverride, landingPageOptionsWithViews, sharedLandingPage]
  )
  return (
    <Stack spacing={2}>
      {visibleSubview === 'root' && <Typography level="h3" startDecorator={<SettingsRoundedIcon />}>Settings</Typography>}
      {visibleSubview === 'root' && <NativeAppSettingsButton />}
      {demoSettingsLocked && (
        <Alert color="warning" variant="soft">
          This is the public demo. Settings and authentication changes you make here will not take effect.
        </Alert>
      )}

      {visibleSubview === 'root' ? (
        <Stack spacing={1.5}>
          <SettingsOverviewCard
            title="General"
            description="Application layout defaults and device-specific interface preferences."
            onAction={() => navigate(settingsPath('/settings/general'))}
          />

          {selfHosted && <LicenseSettingsSection canManage={canManageSettings} />}

          {showsWorkspaceAuthenticationSection && (
            <SettingsOverviewCard
              title="Authentication"
              description={selfHosted
                ? 'Authentication setup, sessions, and user or role management.'
                : 'Authentication setup, support access, sessions, and user or role management.'}
              onAction={() => navigate(settingsPath('/settings/authentication'))}
            />
          )}

          {showsWorkspacePluginManager && (
            <SettingsOverviewCard
              title="Plugins"
              description="Plugins available for printers, notifications, integrations, and workflow tools."
              onAction={() => navigate(settingsPath('/settings/plugins'))}
            />
          )}

          {showsWorkspaceNotifications && (
            <SettingsOverviewCard
              title="Notifications"
              description="Notification channels and message templates for print activity."
              onAction={() => navigate(settingsPath('/settings/notifications'))}
            />
          )}

          {showsWorkspaceBridges && (
            <SettingsOverviewCard
              title="Bridges"
              description="Set up bridges, rename them, and review which bridge owns active printers."
              onAction={() => navigate(settingsPath('/settings/bridges'))}
            />
          )}

          {showsSlicerEngines && (
            <SettingsOverviewCard
              title="Slicing"
              description="Bambu Studio versions this workspace slices with, and the printer, process and material presets it has uploaded."
              onAction={() => navigate(settingsPath('/settings/slicing'))}
            />
          )}

          {showsServerBackups && (
            <SettingsOverviewCard
              title="Backups"
              description="Automatic whole-install backups, manual backups, and restore."
              onAction={() => navigate(settingsPath('/settings/backups'))}
            />
          )}

          {showsWorkspaceLogs && (
            <SettingsOverviewCard
              title="Logs"
              description="Diagnostic output for bridges, printers, plugins, and background work."
              onAction={() => navigate(settingsPath('/settings/logs'))}
            />
          )}
        </Stack>
      ) : visibleSubview === 'auth-users' || visibleSubview === 'auth-roles' ? (
        <Stack spacing={pageSectionStackSpacing}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Authentication', onClick: () => navigate(settingsPath('/settings/authentication')) },
              { label: visibleSubview === 'auth-users' ? 'Users' : 'Roles' }
            ]}
            description={visibleSubview === 'auth-users'
              ? 'Manage user accounts, role assignments, and sign-in access.'
              : 'Review permissions across roles and open any role to edit its access policy.'}
          />

          <AuthAccessSection
            status={authManagementStatusQuery.data}
            statusLoading={authManagementStatusQuery.isLoading}
            statusError={authManagementStatusError}
            authProviders={authProviders}
            authScopeKey={authScopeKey}
            actorEmail={authBootstrapQuery.data?.actor.email ?? ''}
            canManageSupportAccess={canManageSupportAccess}
            mode={visibleSubview === 'auth-users' ? 'users' : 'roles'}
            onOpenUsers={() => navigate(settingsPath('/settings/auth/users'))}
            onOpenRoles={() => navigate(settingsPath('/settings/auth/roles'))}
          />
        </Stack>
      ) : visibleSubview === 'general' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'General' }
            ]}
            description="Application layout defaults and device-specific interface preferences."
          />

          {(sharedSettingsError || sharedSettingsSaveError) && (
            <Alert color="danger">
              {sharedSettingsSaveError ?? sharedSettingsError}
            </Alert>
          )}

          <ThemeSettingCard
            sharedScopeLabel="everyone in this workspace"
            sharedAppTheme={sharedAppTheme}
            deviceAppThemeOverride={deviceAppThemeOverride}
            canManageSettings={canManageSettings}
            sharedSettingsSaving={sharedSettingsSaving}
            onSetSharedAppTheme={onSetSharedAppTheme}
            onSetDeviceAppTheme={onSetDeviceAppTheme}
            onClearDeviceAppThemeOverride={onClearDeviceAppThemeOverride}
          />

          {/*
            Hidden where there is nothing to choose between. A self-hosted
            workspace has exactly one destination, and the shell forces it, a
            picker that silently loses every time is worse than no picker. The
            nav-order card below hides itself the same way, via its own empty
            option list.
          */}
          {landingPageOptions.length > 0 && (
          <GeneralSettingCard
            title="Default page"
            description="Choose which page opens first, including enabled plugin pages and saved printer views."
            resetDisabled={deviceLandingPageOverride == null && !(canManageSettings && sharedLandingPage !== DEFAULT_APP_LANDING_PAGE)}
            onReset={() => {
              if (canManageSettings) onSetSharedLandingPage(DEFAULT_APP_LANDING_PAGE)
              onClearDeviceLandingPageOverride()
            }}
          >
            <GeneralSettingSelectRow
              label="Default setting"
              helper="Shared with everyone in this workspace, and applied to devices that do not have their own override."
            >
              <Select<LandingPageSettingSelectValue>
                value={sharedLandingPageSelectValue}
                disabled={sharedSettingsSaving}
                onChange={(_event, value) => {
                  if (!value) return
                  onSetSharedLandingPage(value)
                }}
              >
                {resolvedLandingPageOptions.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
              </Select>
            </GeneralSettingSelectRow>

            <GeneralSettingSelectRow
              label="This device"
              helper="Saved in this browser, for this workspace only. Other workspaces keep their own. Choose follow default to inherit the shared setting."
            >
              <Select<DeviceLandingPageSettingSelectValue>
                value={deviceLandingPageSelectValue}
                onChange={(_event, value) => {
                  if (!value) return
                  if (value === 'follow-default') {
                    onClearDeviceLandingPageOverride()
                    return
                  }
                  onSetDeviceLandingPage(value)
                }}
              >
                <Option value="follow-default">Follow default setting</Option>
                {resolvedLandingPageOptions.map((option) => (
                  <Option key={option.value} value={option.value}>{option.label} on this device</Option>
                ))}
              </Select>
            </GeneralSettingSelectRow>

            {deviceLandingPageOverride != null && (
              <DeviceOverrideNotice
                message="This device is currently opening its own page instead of the shared default."
                onClear={onClearDeviceLandingPageOverride}
              />
            )}
          </GeneralSettingCard>
          )}

          <GeneralSettingCard
            title="Full-width layout"
            description="Remove the desktop max-width cap so the app can expand across the full viewport on wide screens."
            resetDisabled={deviceUnconstrainedWidthOverride == null && !(canManageSettings && sharedUnconstrainedWidth)}
            onReset={() => {
              if (canManageSettings) onSetSharedUnconstrainedWidth(false)
              onClearDeviceUnconstrainedWidthOverride()
            }}
          >
            <GeneralSettingSelectRow
              label="Default setting"
              helper="Shared with everyone in this workspace, and applied to devices that do not have their own override."
            >
              <Select<WidthSettingSelectValue>
                value={sharedWidthSelectValue}
                disabled={sharedSettingsSaving}
                onChange={(_event, value) => {
                  if (!value) return
                  onSetSharedUnconstrainedWidth(value === 'full-width')
                }}
              >
                <Option value="centered">Centered width</Option>
                <Option value="full-width">Full-width layout</Option>
              </Select>
            </GeneralSettingSelectRow>

            <GeneralSettingSelectRow
              label="This device"
              helper="Saved in this browser and applied in every workspace on it, unlike the page and tab-order choices above. Choose follow default to inherit the shared setting."
            >
              <Select<DeviceWidthSettingSelectValue>
                value={deviceWidthSelectValue}
                onChange={(_event, value) => {
                  if (!value) return
                  if (value === 'follow-default') {
                    onClearDeviceUnconstrainedWidthOverride()
                    return
                  }
                  onSetDeviceUnconstrainedWidth(value === 'full-width')
                }}
              >
                <Option value="follow-default">Follow default setting</Option>
                <Option value="centered">Centered width on this device</Option>
                <Option value="full-width">Full-width on this device</Option>
              </Select>
            </GeneralSettingSelectRow>

            {deviceUnconstrainedWidthOverride != null && (
              <DeviceOverrideNotice
                message="This device is currently using its own width setting instead of the shared default."
                onClear={onClearDeviceUnconstrainedWidthOverride}
              />
            )}
          </GeneralSettingCard>

          {onSetSharedNavTabOrder && onSetDeviceNavTabOrder && onClearDeviceNavTabOrderOverride && navTabOptions.length > 0 && (
            <GeneralSettingCard
              title="Navigation order"
              description="Reorder the primary navigation tabs. Settings, Account, and platform tabs always stay at the end."
              resetDisabled={deviceNavTabOrder == null && !(canManageSettings && sharedNavTabOrder.length > 0)}
              onReset={() => {
                if (canManageSettings) onSetSharedNavTabOrder?.([])
                onClearDeviceNavTabOrderOverride?.()
              }}
            >
              <Stack spacing={0.5}>
                <FormLabel>Default order</FormLabel>
                <Typography level="body-xs" textColor="text.tertiary">
                  {canManageSettings
                    ? 'Shared with everyone in this workspace, and applied to devices that do not set their own order.'
                    : 'Set by a workspace admin. You can still set a per-device order below.'}
                </Typography>
                <NavTabOrderEditor
                  options={navTabOptions}
                  order={sharedNavTabOrder}
                  onChange={onSetSharedNavTabOrder}
                  disabled={!canManageSettings || sharedSettingsSaving}
                />
              </Stack>

              <Stack spacing={0.5}>
                <FormLabel>This device</FormLabel>
                <Typography level="body-xs" textColor="text.tertiary">
                  Saved in this browser, for this workspace only. Other workspaces keep their own order.
                </Typography>
                <NavTabOrderEditor
                  options={navTabOptions}
                  order={deviceNavTabOrder ?? sharedNavTabOrder}
                  onChange={onSetDeviceNavTabOrder}
                />
              </Stack>

              {deviceNavTabOrder != null && (
                <DeviceOverrideNotice
                  message="This device is currently using its own navigation order instead of the shared default."
                  onClear={onClearDeviceNavTabOrderOverride}
                />
              )}
            </GeneralSettingCard>
          )}
        </Stack>
      ) : visibleSubview === 'authentication' ? (
        // Section spacing, not card spacing: the provider panels and `AuthAccessSection`'s own
        // sections stack as peers here, so they need the same gap as sections anywhere else.
        <Stack spacing={pageSectionStackSpacing}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Authentication' }
            ]}
            description={selfHosted
              ? 'Authentication setup, sessions, and shortcuts into user and role management.'
              : 'Authentication setup, support access, sessions, and shortcuts into user and role management.'}
          />

          {/* The provider panels are a CARD LIST, so they keep card spacing among themselves; the
              section gap belongs between this group and the sections below, not inside it. */}
          <Stack spacing={1.5}>
            <StaticPluginSlot
              name="settings.authenticationProviders"
              context={{
                authProviders,
                authBootstrapReady: authBootstrapQuery.isSuccess,
                authScopeKey,
                canManageAuthProviders
              }}
            />

            {showsAuthSetup && (!hasWorkspaceContext || selfHosted) && (
              <StaticPluginSlot
                name="settings.authenticationSetup"
                context={{
                  authProviders,
                  authSetupRequired: authBootstrapQuery.data?.setupRequired ?? false,
                  authBootstrapReady: authBootstrapQuery.isSuccess,
                  authWorkspaceId,
                  authScopeKey,
                  authHost: 'settings',
                  actorType: authBootstrapQuery.data?.actor.type ?? 'anonymous',
                  canManageAuthProviders
                }}
              />
            )}
          </Stack>

          {canViewAuth && (
            <AuthAccessSection
              status={authManagementStatusQuery.data}
              statusLoading={authManagementStatusQuery.isLoading}
              statusError={authManagementStatusError}
              authProviders={authProviders}
              authScopeKey={authScopeKey}
              actorEmail={authBootstrapQuery.data?.actor.email ?? ''}
              canManageSupportAccess={canManageSupportAccess}
              mode="overview"
              onOpenUsers={() => navigate(settingsPath('/settings/auth/users'))}
              onOpenRoles={() => navigate(settingsPath('/settings/auth/roles'))}
            />
          )}
        </Stack>
      ) : visibleSubview === 'plugins' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Plugins' }
            ]}
            description="Plugins available for printers, notifications, integrations, and workflow tools."
          />
          <PluginManagerSection surface="workspace" />
        </Stack>
      ) : visibleSubview === 'bridges' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Bridges' }
            ]}
            description="Set up bridges and keep their names organized."
          />
          <BridgeSettingsSection />
        </Stack>
      ) : visibleSubview === 'slicing' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Slicing' }
            ]}
            description="Bambu Studio versions and presets used for server-side slicing."
          />
          <SlicerEngineVisibilityCard canManage={canManageSettings} />
          {/* Installing and removing stays self-hosted: the slicer is shared by
              every workspace, so on the hosted plan one admin's removal would
              break slicing for the rest. */}
          {selfHosted && <SlicerEnginesSection canManage={canManageSettings} />}

          {/* The SAME manager the editor opens from its gear, not a second one.
              Presets were reachable only from inside the editor, which meant
              curating a workspace's shared presets required opening a model
              first. Mirrored rather than moved: picking a preset mid-edit and
              curating the library are different jobs, and the editor's dialog
              is the right surface for the first. */}
          {/* Heading only: the section carries its own explanation, and two
              descriptions stacked read as a rendering fault. */}
          <Typography level="title-sm">Slicing presets</Typography>
          <SlicingPresetsSettingsSection />
        </Stack>
      ) : visibleSubview === 'backups' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Backups' }
            ]}
            description="Automatic whole-install backups, manual backups, and restore."
          />
          <ServerBackupsSection canManage={canManageSettings} />
        </Stack>
      ) : visibleSubview === 'notifications' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Notifications' }
            ]}
            description="Notification channels and message templates for print activity."
          />
          {/* Says the scope, as the platform side already does. The same panel
              configures two different stores depending on where it is opened,
              and only one of them said which. */}
          <NotificationChannelsPanel description="Configure how this workspace's print alerts reach you. Each channel delivers through this workspace's own configuration, separate from other workspaces and from the platform's." />
          <NotificationTemplatesPanel />
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Logs' }
            ]}
            description="Diagnostic output for bridges, printers, plugins, and background work."
          />
          <LogsPanel embedded surface="workspace" />
        </Stack>
      )}
    </Stack>
  )
}

function resolveSettingsSubview(pathname: string): SettingsSubview {
  if (pathname === '/settings' || pathname === '/settings/') return 'root'
  if (pathname === '/settings/authentication') return 'authentication'
  if (pathname === '/settings/plugins') return 'plugins'
  if (pathname === '/settings/notifications') return 'notifications'
  if (pathname === '/settings/logs') return 'logs'
  if (pathname === '/settings/bridges') return 'bridges'
  if (pathname === '/settings/slicing') return 'slicing'
  if (pathname === '/settings/backups') return 'backups'
  if (pathname === '/settings/auth/users') return 'auth-users'
  if (pathname === '/settings/auth/roles') return 'auth-roles'
  if (pathname === '/settings/general') return 'general'
  return 'root'
}

function resolveVisibleWorkspaceSettingsSubview(
  subview: SettingsSubview,
  options: {
    showsWorkspaceAuthenticationSection: boolean
    showsWorkspacePluginManager: boolean
    showsWorkspaceNotifications: boolean
    showsWorkspaceLogs: boolean
    showsWorkspaceBridges: boolean
    showsSlicerEngines: boolean
    showsServerBackups: boolean
    canViewAuth: boolean
  }
) {
  if (subview === 'authentication' && !options.showsWorkspaceAuthenticationSection) return 'root'
  if ((subview === 'auth-users' || subview === 'auth-roles') && !options.showsWorkspaceAuthenticationSection) return 'root'
  if ((subview === 'auth-users' || subview === 'auth-roles') && !options.canViewAuth) return 'authentication'
  if (subview === 'plugins' && !options.showsWorkspacePluginManager) return 'root'
  if (subview === 'notifications' && !options.showsWorkspaceNotifications) return 'root'
  if (subview === 'logs' && !options.showsWorkspaceLogs) return 'root'
  if (subview === 'bridges' && !options.showsWorkspaceBridges) return 'root'
  if (subview === 'slicing' && !options.showsSlicerEngines) return 'root'
  if (subview === 'backups' && !options.showsServerBackups) return 'root'
  return subview
}

function SettingsOverviewCard({
  title,
  description,
  onAction
}: {
  title: string
  description: string
  onAction: () => void
}) {
  return (
    <Card
      component="button"
      type="button"
      variant="outlined"
      onClick={onAction}
      sx={{
        p: 2,
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
        '&:hover': {
          backgroundColor: 'background.level1',
          borderColor: 'primary.softColor'
        },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'focusVisible',
          outlineOffset: '2px'
        }
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        justifyContent="space-between"
        alignItems="center"
      >
        <Stack spacing={0.4} sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-lg">{title}</Typography>
          <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
        </Stack>
        <Typography
          aria-hidden="true"
          level="title-lg"
          textColor="text.tertiary"
          sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
        >
          <KeyboardArrowRightRoundedIcon />
        </Typography>
      </Stack>
    </Card>
  )
}

function ensureLandingPageOptions(
  options: ReadonlyArray<LandingPageOption>,
  selectedValues: ReadonlyArray<AppLandingPageSetting | null>
): ReadonlyArray<LandingPageOption> {
  const result = [...options]
  const seen = new Set(result.map((option) => option.value))

  for (const value of selectedValues) {
    if (!value || seen.has(value)) {
      continue
    }
    result.push({
      value,
      label: `${formatLandingPageLabel(value)} (currently unavailable)`
    })
    seen.add(value)
  }

  return result
}

function formatLandingPageLabel(value: string): string {
  // A stored view address whose view has not loaded (or was deleted): the raw
  // path would render as a meaningless id, so name the kind instead.
  if (isPrinterViewPath(value)) return 'Printers view'
  return value
    .replace(/^\//, '')
    .split('/')
    .flatMap((segment) => segment.split('-'))
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}
