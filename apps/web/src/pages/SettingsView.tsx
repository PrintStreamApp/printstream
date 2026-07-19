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
import { NestedViewHeader } from '../components/NestedViewHeader'
import { NotificationChannelsPanel } from '../components/NotificationChannelsPanel'
import { NotificationTemplatesPanel } from '../components/NotificationTemplatesPanel'
import { BridgeSettingsSection } from '../components/settings/BridgeManagementSection'
import { NavTabOrderEditor } from '../components/settings/NavTabOrderEditor'
import { SlicerDeveloperModeCard } from '../components/settings/SlicerDeveloperModeCard'
import { PluginManagerSection } from '../components/PluginManagerSection'
import { apiFetch } from '../lib/apiClient'
import { authQueryKeys, resolveAuthScope, useAuthBootstrapQuery } from '../lib/authQuery'
import { CORE_LANDING_PAGE_OPTIONS, type LandingPageOption } from '../lib/landingPageOptions'
import { DeviceOverrideNotice, GeneralSettingCard, GeneralSettingSelectRow } from '../components/settings/GeneralSettingControls'
import { ThemeSettingCard } from '../components/settings/ThemeSettingCard'
import { resolveSettingsAuthState } from '../lib/settingsAuth'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { buildTenantWorkspacePath, parseWorkspacePathname } from '../lib/workspaceRoute'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { LicenseSettingsSection } from './LicenseSettingsSection'
import { LogsPanel } from './LogsView'

type LandingPageSettingSelectValue = AppLandingPageSetting
type DeviceLandingPageSettingSelectValue = 'follow-default' | LandingPageSettingSelectValue
type WidthSettingSelectValue = 'centered' | 'full-width'
type DeviceWidthSettingSelectValue = 'follow-default' | WidthSettingSelectValue
type SettingsSubview = 'root' | 'general' | 'authentication' | 'plugins' | 'notifications' | 'logs' | 'bridges' | 'slicing' | 'auth-users' | 'auth-roles'

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
  const { authTenantId, authScopeKey } = resolveAuthScope(authBootstrapQuery.data)
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
  const hasTenantContext = authBootstrapQuery.data?.tenant != null
  const platformAuthEnabled = authBootstrapQuery.data?.platformAuthEnabled ?? false
  const demoSettingsLocked = authBootstrapQuery.data?.tenant?.slug === 'demo'
  // Managed-bridge installs own a single bundled bridge the operator never
  // manages, so the entire Bridges surface is hidden.
  const { managedBridge, selfHosted } = useRuntimePolicy()
  // Self-hosted (OSS) is a single-workspace install with no platform auth step,
  // so the workspace configures its own sign-in directly; the cloud gates the
  // workspace section on platform auth existing first.
  const showsTenantAuthenticationSection = hasTenantContext && showsAuthenticationSection && (platformAuthEnabled || selfHosted)
  const showsTenantPluginManager = hasTenantContext && canManageSettings
  const showsTenantNotifications = hasTenantContext && canManageSettings
  const showsTenantLogs = hasTenantContext && canManageSettings
  const showsTenantBridges = hasTenantContext && canManageSettings && !managedBridge
  const showsTenantSlicingProfiles = hasTenantContext && canManageSettings
  const workspacePath = parseWorkspacePathname(location.pathname)
  const currentSubview = resolveSettingsSubview(workspacePath.appPathname)
  const settingsPath = (path = '/settings') => workspacePath.tenantSlug
    ? buildTenantWorkspacePath(workspacePath.tenantSlug, path)
    : path
  const visibleSubview = resolveVisibleTenantSettingsSubview(currentSubview, {
    showsTenantAuthenticationSection,
    showsTenantPluginManager,
    showsTenantNotifications,
    showsTenantLogs,
    showsTenantBridges,
    showsTenantSlicingProfiles,
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
  const resolvedLandingPageOptions = React.useMemo(
    () => ensureLandingPageOptions(landingPageOptions, [sharedLandingPage, deviceLandingPageOverride]),
    [deviceLandingPageOverride, landingPageOptions, sharedLandingPage]
  )
  return (
    <Stack spacing={2}>
      {visibleSubview === 'root' && <Typography level="h3" startDecorator={<SettingsRoundedIcon />}>Settings</Typography>}
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

          {showsTenantAuthenticationSection && (
            <SettingsOverviewCard
              title="Authentication"
              description={selfHosted
                ? 'Authentication setup, sessions, and user or role management.'
                : 'Authentication setup, support access, sessions, and user or role management.'}
              onAction={() => navigate(settingsPath('/settings/authentication'))}
            />
          )}

          {showsTenantPluginManager && (
            <SettingsOverviewCard
              title="Plugins"
              description="Plugins available for printers, notifications, integrations, and workflow tools."
              onAction={() => navigate(settingsPath('/settings/plugins'))}
            />
          )}

          {showsTenantNotifications && (
            <SettingsOverviewCard
              title="Notifications"
              description="Notification channels and message templates for print activity."
              onAction={() => navigate(settingsPath('/settings/notifications'))}
            />
          )}

          {showsTenantBridges && (
            <SettingsOverviewCard
              title="Bridges"
              description="Set up bridges, rename them, and review which bridge owns active printers."
              onAction={() => navigate(settingsPath('/settings/bridges'))}
            />
          )}

          {showsTenantSlicingProfiles && (
            <SettingsOverviewCard
              title="Slicing"
              description="Slicing behaviour for this workspace; manage custom presets from the editor."
              onAction={() => navigate(settingsPath('/settings/slicing'))}
            />
          )}

          {showsTenantLogs && (
            <SettingsOverviewCard
              title="Logs"
              description="Diagnostic output for bridges, printers, plugins, and background work."
              onAction={() => navigate(settingsPath('/settings/logs'))}
            />
          )}
        </Stack>
      ) : visibleSubview === 'auth-users' || visibleSubview === 'auth-roles' ? (
        <Stack spacing={2}>
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
            sharedAppTheme={sharedAppTheme}
            deviceAppThemeOverride={deviceAppThemeOverride}
            canManageSettings={canManageSettings}
            sharedSettingsSaving={sharedSettingsSaving}
            onSetSharedAppTheme={onSetSharedAppTheme}
            onSetDeviceAppTheme={onSetDeviceAppTheme}
            onClearDeviceAppThemeOverride={onClearDeviceAppThemeOverride}
          />

          <GeneralSettingCard
            title="Default page"
            description="Choose which page opens first, including enabled plugin pages."
            resetDisabled={deviceLandingPageOverride == null && !(canManageSettings && sharedLandingPage !== DEFAULT_APP_LANDING_PAGE)}
            onReset={() => {
              if (canManageSettings) onSetSharedLandingPage(DEFAULT_APP_LANDING_PAGE)
              onClearDeviceLandingPageOverride()
            }}
          >
            <GeneralSettingSelectRow label="Default setting" helper="Shared default applied to devices that do not have their own override.">
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

            <GeneralSettingSelectRow label="This device" helper="Saved in this browser only. Choose follow default to inherit the shared setting.">
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

          <GeneralSettingCard
            title="Full-width layout"
            description="Remove the desktop max-width cap so the app can expand across the full viewport on wide screens."
            resetDisabled={deviceUnconstrainedWidthOverride == null && !(canManageSettings && sharedUnconstrainedWidth)}
            onReset={() => {
              if (canManageSettings) onSetSharedUnconstrainedWidth(false)
              onClearDeviceUnconstrainedWidthOverride()
            }}
          >
            <GeneralSettingSelectRow label="Default setting" helper="Shared default applied to devices that do not have their own override.">
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

            <GeneralSettingSelectRow label="This device" helper="Saved in this browser only. Choose follow default to inherit the shared setting.">
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
                    ? 'Shared default applied to devices that do not set their own order.'
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
                  Saved in this browser only. Reordering here overrides the default order on this device.
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
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Authentication' }
            ]}
            description={selfHosted
              ? 'Authentication setup, sessions, and shortcuts into user and role management.'
              : 'Authentication setup, support access, sessions, and shortcuts into user and role management.'}
          />

          <StaticPluginSlot
            name="settings.authenticationProviders"
            context={{
              authProviders,
              authBootstrapReady: authBootstrapQuery.isSuccess,
              authScopeKey,
              canManageAuthProviders
            }}
          />

          {showsAuthSetup && (!hasTenantContext || selfHosted) && (
            <StaticPluginSlot
              name="settings.authenticationSetup"
              context={{
                authProviders,
                authSetupRequired: authBootstrapQuery.data?.setupRequired ?? false,
                authBootstrapReady: authBootstrapQuery.isSuccess,
                authTenantId,
                authScopeKey,
                authHost: 'settings',
                actorType: authBootstrapQuery.data?.actor.type ?? 'anonymous',
                canManageAuthProviders
              }}
            />
          )}

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
          <PluginManagerSection surface="tenant" />
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
      ) : visibleSubview === 'notifications' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Notifications' }
            ]}
            description="Notification channels and message templates for print activity."
          />
          <NotificationChannelsPanel />
          <NotificationTemplatesPanel />
        </Stack>
      ) : visibleSubview === 'slicing' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Slicing' }
            ]}
            description="Slicing behaviour for this workspace. Custom presets are managed from the editor’s settings."
          />
          <SlicerDeveloperModeCard />
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
          <LogsPanel embedded surface="tenant" />
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
  if (pathname === '/settings/auth/users') return 'auth-users'
  if (pathname === '/settings/auth/roles') return 'auth-roles'
  if (pathname === '/settings/general') return 'general'
  return 'root'
}

function resolveVisibleTenantSettingsSubview(
  subview: SettingsSubview,
  options: {
    showsTenantAuthenticationSection: boolean
    showsTenantPluginManager: boolean
    showsTenantNotifications: boolean
    showsTenantLogs: boolean
    showsTenantBridges: boolean
    showsTenantSlicingProfiles: boolean
    canViewAuth: boolean
  }
) {
  if (subview === 'authentication' && !options.showsTenantAuthenticationSection) return 'root'
  if ((subview === 'auth-users' || subview === 'auth-roles') && !options.showsTenantAuthenticationSection) return 'root'
  if ((subview === 'auth-users' || subview === 'auth-roles') && !options.canViewAuth) return 'authentication'
  if (subview === 'plugins' && !options.showsTenantPluginManager) return 'root'
  if (subview === 'notifications' && !options.showsTenantNotifications) return 'root'
  if (subview === 'logs' && !options.showsTenantLogs) return 'root'
  if (subview === 'bridges' && !options.showsTenantBridges) return 'root'
  if (subview === 'slicing' && !options.showsTenantSlicingProfiles) return 'root'
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
  return value
    .replace(/^\//, '')
    .split('/')
    .flatMap((segment) => segment.split('-'))
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}
