import React from 'react'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import FileUploadRoundedIcon from '@mui/icons-material/FileUploadRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import { Alert, Box, Button, Card, CardContent, Checkbox, Chip, FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy'
import {
  type AppLandingPageSetting,
  type AppThemeSetting,
  type BridgeListResponse,
  type BridgeResponse,
  type BridgeSummary,
  type BridgeTestResponse,
  type BridgeUpdateActionResponse,
  extractErrorMessage,
  type AuthManagementStatus,
  type SlicingProfileResponse,
  type SlicingProfilesResponse,
  type SlicingProfileSummary,
  type UploadSlicingProfile
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { AuthAccessSection } from '../components/AuthAccessSection'
import { ConfirmActionDialog } from '../components/ConfirmActionDialog'
import { type DirectorySortDirection, type DirectorySortOption } from '../components/DirectoryControls'
import { DirectoryFiltersButton, DirectoryFiltersDialog, DirectoryPrimaryToolbar } from '../components/DirectoryToolbar'
import { EmptyState } from '../components/EmptyState'
import { NestedViewHeader } from '../components/NestedViewHeader'
import { NotificationChannelsPanel } from '../components/NotificationChannelsPanel'
import { NotificationTemplatesPanel } from '../components/NotificationTemplatesPanel'
import { PaginatedSection } from '../components/PaginationFooter'
import { PluginManagerSection } from '../components/PluginManagerSection'
import { usePromptDialog } from '../components/PromptDialogProvider'
import { ApiError, apiFetch } from '../lib/apiClient'
import { buildBridgeConnectionStatItems } from '../lib/bridgeConnectionStats'
import { invalidateBridgeQueries } from '../lib/bridgeQueryInvalidation'
import { formatBridgeUpdateStatus } from '../lib/bridgeUpdateStatus'
import { authQueryKeys, resolveAuthScope, useAuthBootstrapQuery } from '../lib/authQuery'
import { CORE_LANDING_PAGE_OPTIONS, type LandingPageOption } from '../lib/landingPageOptions'
import { resolveSettingsAuthState } from '../lib/settingsAuth'
import {
  DEFAULT_SLICING_PROFILE_SORT_DIRECTION,
  DEFAULT_SLICING_PROFILE_SORT_VALUE,
  filterSlicingProfiles,
  formatSlicingProfileKind,
  setAllFilteredSlicingProfilesSelected,
  sortSlicingProfiles,
  toggleSlicingProfileSelection,
  type SlicingProfileKindFilter,
  type SlicingProfileSortValue
} from '../lib/slicingProfileDirectory'
import { buildTenantWorkspacePath, parseWorkspacePathname } from '../lib/workspaceRoute'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { LogsPanel } from './LogsView'

type ThemeSettingSelectValue = AppThemeSetting
type DeviceThemeSettingSelectValue = 'follow-default' | ThemeSettingSelectValue
type LandingPageSettingSelectValue = AppLandingPageSetting
type DeviceLandingPageSettingSelectValue = 'follow-default' | LandingPageSettingSelectValue
type WidthSettingSelectValue = 'centered' | 'full-width'
type DeviceWidthSettingSelectValue = 'follow-default' | WidthSettingSelectValue
type SettingsSubview = 'root' | 'general' | 'authentication' | 'plugins' | 'notifications' | 'logs' | 'bridges' | 'slicing' | 'auth-users' | 'auth-roles'

const SLICING_PROFILE_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
const SLICING_PROFILE_SORT_OPTIONS: ReadonlyArray<DirectorySortOption<SlicingProfileSortValue>> = [
  { value: 'updatedAt', label: 'Updated' },
  { value: 'name', label: 'Name' },
  { value: 'kind', label: 'Type' }
]

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
  onSetSharedLandingPage
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
  const showsTenantAuthenticationSection = hasTenantContext && showsAuthenticationSection && platformAuthEnabled
  const showsTenantPluginManager = hasTenantContext && canManageSettings
  const showsTenantNotifications = hasTenantContext && canManageSettings
  const showsTenantLogs = hasTenantContext && canManageSettings
  const showsTenantBridges = hasTenantContext && canManageSettings
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
  const sharedThemeSelectValue: ThemeSettingSelectValue = sharedAppTheme
  const deviceThemeSelectValue: DeviceThemeSettingSelectValue = deviceAppThemeOverride ?? 'follow-default'
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
      {visibleSubview === 'root' && <Typography level="h3">Settings</Typography>}
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

          {showsTenantAuthenticationSection && (
            <SettingsOverviewCard
              title="Authentication"
              description="Authentication setup, support access, sessions, and user or role management."
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
              description="Upload BambuStudio printer, filament, and quality profiles for server-side slicing."
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

          <GeneralSettingCard
            title="Theme"
            description="Choose between the current default appearance and an alternate Aurora background treatment."
          >
            <GeneralSettingSelectRow label="Default setting" helper="Shared default applied to devices that do not have their own override.">
              <Select<ThemeSettingSelectValue>
                value={sharedThemeSelectValue}
                disabled={sharedSettingsSaving}
                onChange={(_event, value) => {
                  if (!value) return
                  onSetSharedAppTheme(value)
                }}
              >
                <Option value="default">Default theme</Option>
                <Option value="aurora">Aurora theme</Option>
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
                <Option value="default">Default theme on this device</Option>
                <Option value="aurora">Aurora theme on this device</Option>
              </Select>
            </GeneralSettingSelectRow>

            {deviceAppThemeOverride != null && (
              <DeviceOverrideNotice
                message="This device is currently using its own theme setting instead of the shared default."
                onClear={onClearDeviceAppThemeOverride}
              />
            )}
          </GeneralSettingCard>

          <GeneralSettingCard
            title="Default page"
            description="Choose which page opens first, including enabled plugin pages."
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
        </Stack>
      ) : visibleSubview === 'authentication' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Settings', onClick: () => navigate(settingsPath()) },
              { label: 'Authentication' }
            ]}
            description="Authentication setup, support access, sessions, and shortcuts into user and role management."
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

          {showsAuthSetup && !hasTenantContext && (
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
            description="Upload BambuStudio profiles used by server-side slicing."
          />
          <SlicingProfilesSettingsSection />
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

function GeneralSettingCard({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Box>
            <Typography level="title-md">{title}</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              {description}
            </Typography>
          </Box>
          <Stack spacing={1.25}>
            {children}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}

function GeneralSettingSelectRow({
  label,
  helper,
  children
}: {
  label: string
  helper: string
  children: React.ReactNode
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      alignItems={{ xs: 'stretch', sm: 'center' }}
      justifyContent="space-between"
    >
      <Stack spacing={0.35} sx={{ minWidth: 0, flex: 1 }}>
        <FormLabel>{label}</FormLabel>
        <Typography level="body-xs" textColor="text.tertiary">
          {helper}
        </Typography>
      </Stack>
      <FormControl size="sm" sx={{ width: { xs: '100%', sm: 240 }, flexShrink: 0 }}>
        {children}
      </FormControl>
    </Stack>
  )
}

function DeviceOverrideNotice({ message, onClear }: { message: string; onClear: () => void }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Typography level="body-xs" textColor="text.tertiary">
        {message}
      </Typography>
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={onClear}
      >
        Use shared setting on this device
      </Button>
    </Stack>
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

function SlicingProfilesSettingsSection() {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')
  const [kindFilter, setKindFilter] = React.useState<SlicingProfileKindFilter>('all')
  const [filtersDialogOpen, setFiltersDialogOpen] = React.useState(false)
  const [sortValue, setSortValue] = React.useState<SlicingProfileSortValue>(DEFAULT_SLICING_PROFILE_SORT_VALUE)
  const [sortDirection, setSortDirection] = React.useState<DirectorySortDirection>(DEFAULT_SLICING_PROFILE_SORT_DIRECTION)
  const [pageSize, setPageSize] = React.useState<(typeof SLICING_PROFILE_PAGE_SIZE_OPTIONS)[number]>(10)
  const [page, setPage] = React.useState(0)
  const [selectionMode, setSelectionMode] = React.useState(false)
  const [selectedProfileIds, setSelectedProfileIds] = React.useState<string[]>([])
  const profilesQuery = useQuery({
    queryKey: ['slicing-profiles'],
    queryFn: ({ signal }) => apiFetch<SlicingProfilesResponse>('/api/slicing/profiles', { signal })
  })
  const uploadProfile = useMutation({
    // Errors (incl. the 409 same-name conflict) are handled locally in handleUploadFile, so opt out
    // of the global mutation-error toast.
    meta: { suppressGlobalErrorToast: true },
    mutationFn: async ({ file, overwrite }: { file: File; overwrite?: boolean }) => {
      return await apiFetch<SlicingProfileResponse>('/api/slicing/profiles', {
        method: 'POST',
        body: await buildSlicingProfileUpload(file, overwrite)
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
    }
  })
  /**
   * Uploads a profile, asking the user to confirm before overwriting any existing same-name preset
   * (the server reports the collision as a 409 instead of replacing silently).
   */
  const handleUploadFile = async (file: File) => {
    setUploadError(null)
    try {
      await uploadProfile.mutateAsync({ file })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const conflicts = Array.isArray((error.payload as { conflicts?: unknown })?.conflicts)
          ? (error.payload as { conflicts: string[] }).conflicts
          : []
        const confirmed = await confirm({
          title: 'Replace existing presets?',
          description: conflicts.length > 0
            ? (
              <Stack spacing={0.75}>
                <Typography level="body-sm">
                  Uploading "{file.name}" will overwrite {conflicts.length > 1 ? 'these existing presets' : 'this existing preset'}:
                </Typography>
                <Stack spacing={0.25}>
                  {conflicts.map((name) => (
                    <Typography key={name} level="body-sm" sx={{ fontWeight: 'lg' }}>{name}</Typography>
                  ))}
                </Stack>
              </Stack>
            )
            : `Uploading "${file.name}" will overwrite an existing preset.`,
          confirmLabel: 'Replace',
          color: 'warning'
        })
        if (!confirmed) return
        try {
          await uploadProfile.mutateAsync({ file, overwrite: true })
        } catch (retryError) {
          setUploadError(extractErrorMessage(retryError))
        }
        return
      }
      setUploadError(extractErrorMessage(error))
    }
  }
  const deleteProfiles = useMutation({
    mutationFn: async (profileIds: string[]) => {
      for (const profileId of profileIds) {
        await apiFetch<void>(`/api/slicing/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' })
      }
    },
    onSuccess: async (_data, deletedProfileIds) => {
      setSelectedProfileIds((current) => current.filter((profileId) => !deletedProfileIds.includes(profileId)))
      await queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
    }
  })
  const customProfiles = (profilesQuery.data?.profiles ?? []).filter((profile) => profile.source === 'custom')
  const builtinCounts = countProfilesByKind((profilesQuery.data?.profiles ?? []).filter((profile) => profile.source === 'builtin'))
  const listError = profilesQuery.error ? extractErrorMessage(profilesQuery.error) : null
  const deleteError = deleteProfiles.error ? extractErrorMessage(deleteProfiles.error) : null
  const activeFilterCount = Number(kindFilter !== 'all')
  const selectedProfileIdSet = React.useMemo(() => new Set(selectedProfileIds), [selectedProfileIds])

  React.useEffect(() => {
    const customProfileIdSet = new Set(customProfiles.map((profile) => profile.id))
    setSelectedProfileIds((current) => {
      const next = current.filter((profileId) => customProfileIdSet.has(profileId))
      return next.length === current.length ? current : next
    })
    if (customProfiles.length === 0) {
      setSelectionMode(false)
    }
  }, [customProfiles])

  const filteredProfiles = React.useMemo(
    () => filterSlicingProfiles(customProfiles, search, kindFilter),
    [customProfiles, kindFilter, search]
  )

  const sortedProfiles = React.useMemo(
    () => sortSlicingProfiles(filteredProfiles, sortValue, sortDirection),
    [filteredProfiles, sortDirection, sortValue]
  )

  const pageCount = Math.max(1, Math.ceil(sortedProfiles.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleProfiles = React.useMemo(() => {
    const start = safePage * pageSize
    return sortedProfiles.slice(start, start + pageSize)
  }, [pageSize, safePage, sortedProfiles])
  const selectedProfiles = React.useMemo(
    () => customProfiles.filter((profile) => selectedProfileIdSet.has(profile.id)),
    [customProfiles, selectedProfileIdSet]
  )
  const selectedFilteredCount = filteredProfiles.filter((profile) => selectedProfileIdSet.has(profile.id)).length
  const allFilteredProfilesSelected = filteredProfiles.length > 0 && selectedFilteredCount === filteredProfiles.length
  const singleDeletingProfileId = deleteProfiles.isPending && deleteProfiles.variables?.length === 1
    ? deleteProfiles.variables[0] ?? null
    : null

  function clearFilters() {
    setPage(0)
    setKindFilter('all')
  }

  function resetSearchAndFilters() {
    setPage(0)
    setSearch('')
    setKindFilter('all')
  }

  function toggleProfileSelection(profileId: string) {
    setSelectedProfileIds((current) => toggleSlicingProfileSelection(current, profileId))
  }

  function setAllFilteredProfilesSelected(selected: boolean) {
    setSelectedProfileIds((current) => setAllFilteredSlicingProfilesSelected(current, filteredProfiles, selected))
  }

  function clearSelection() {
    setSelectionMode(false)
    setSelectedProfileIds([])
  }

  async function handleDeleteProfile(profile: SlicingProfileSummary) {
    const confirmed = await confirm({
      title: 'Delete profile?',
      description: `Delete ${profile.name}?`,
      confirmLabel: 'Delete profile',
      color: 'danger'
    })
    if (!confirmed) return
    deleteProfiles.mutate([profile.id])
  }

  async function handleDeleteSelectedProfiles() {
    if (selectedProfiles.length === 0) return
    const confirmed = await confirm({
      title: 'Delete selected profiles?',
      description: selectedProfiles.length === 1
        ? `Delete ${selectedProfiles[0]?.name ?? 'this profile'}?`
        : `Delete ${selectedProfiles.length} selected profiles?`,
      confirmLabel: 'Delete selected',
      color: 'danger'
    })
    if (!confirmed) return
    await deleteProfiles.mutateAsync(selectedProfiles.map((profile) => profile.id))
    setSelectionMode(false)
  }

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography level="title-md">Slicing profiles</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Upload BambuStudio presets for printer settings, filament settings, and quality/process settings.
        </Typography>
      </Box>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
              <Stack spacing={0.5}>
                <Typography level="title-sm">Upload BambuStudio presets</Typography>
                <Typography level="body-sm" textColor="text.tertiary">
                  Upload `.json`, `.bbscfg`, `.bbsflmt`, or preset `.zip` exports. Profile kinds are auto-detected from the file using BambuStudio's own preset rules.
                </Typography>
              </Stack>
              <Button loading={uploadProfile.isPending} onClick={() => inputRef.current?.click()}>
                Upload presets
              </Button>
            </Stack>
            <Box
              component="input"
              type="file"
              accept="application/json,.json,.bbscfg,.bbsflmt,.zip"
              ref={inputRef}
              sx={{ display: 'none' }}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (!file) return
                void handleUploadFile(file)
              }}
            />
            {(uploadError || deleteError) && <Alert color="danger">{uploadError ?? deleteError}</Alert>}
          </Stack>
        </CardContent>
      </Card>

      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Chip size="sm" variant="soft">Built-in printer profiles: {builtinCounts.machine}</Chip>
        <Chip size="sm" variant="soft">Built-in quality profiles: {builtinCounts.process}</Chip>
        <Chip size="sm" variant="soft">Built-in material profiles: {builtinCounts.filament}</Chip>
      </Stack>

      {listError && <Alert color="danger">{listError}</Alert>}
      {!listError && customProfiles.length === 0 ? (
        <EmptyState
          compact
          icon={<FileUploadRoundedIcon />}
          title="No custom profiles yet"
          description="Upload BambuStudio presets above to keep printer, material, and quality profiles ready for server-side slicing."
        />
      ) : (
        <Stack spacing={1.25}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'center' }}
          >
            <Typography level="title-sm">Custom profiles</Typography>
            {filteredProfiles.length > 0 && !selectionMode && (
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}>
                <Button size="sm" variant="soft" onClick={() => setSelectionMode(true)}>
                  Select...
                </Button>
              </Stack>
            )}
            {selectionMode && (
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}>
                <Chip size="sm" variant="soft" color="neutral">
                  {selectedProfiles.length} selected
                </Chip>
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => setAllFilteredProfilesSelected(!allFilteredProfilesSelected)}
                  disabled={filteredProfiles.length === 0 || deleteProfiles.isPending}
                >
                  {allFilteredProfilesSelected ? 'Clear all results' : 'Select all results'}
                </Button>
                <Button size="sm" variant="plain" onClick={clearSelection} disabled={deleteProfiles.isPending}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  color="danger"
                  startDecorator={<DeleteRoundedIcon />}
                  disabled={selectedProfiles.length === 0}
                  loading={deleteProfiles.isPending && (deleteProfiles.variables?.length ?? 0) > 1}
                  onClick={() => void handleDeleteSelectedProfiles()}
                >
                  Delete selected{selectedProfiles.length > 0 ? ` (${selectedProfiles.length})` : ''}
                </Button>
              </Stack>
            )}
          </Stack>

          <DirectoryPrimaryToolbar
            searchValue={search}
            onSearchChange={(value) => {
              setPage(0)
              setSearch(value)
            }}
            searchPlaceholder="Search profile name or type"
            searchAriaLabel="Search slicing profiles"
            filtersButton={<DirectoryFiltersButton activeCount={activeFilterCount} onClick={() => setFiltersDialogOpen(true)} />}
            pageSizeValue={pageSize}
            pageSizeOptions={SLICING_PROFILE_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} per page` }))}
            onPageSizeChange={(value) => {
              setPage(0)
              setPageSize(value as (typeof SLICING_PROFILE_PAGE_SIZE_OPTIONS)[number])
            }}
            pageSizeAriaLabel="Profiles per page"
            pageSizeRenderValue={(value) => `${value} per page`}
            sortValue={sortValue}
            sortOptions={SLICING_PROFILE_SORT_OPTIONS}
            onSortValueChange={(value) => {
              setPage(0)
              setSortValue(value as SlicingProfileSortValue)
            }}
            sortDirection={sortDirection}
            onSortDirectionChange={(direction) => {
              setPage(0)
              setSortDirection(direction)
            }}
            sortAriaLabel="Sort slicing profiles by"
            sortMinWidth={140}
          />

          {activeFilterCount > 0 && (
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {kindFilter !== 'all' && (
                <Chip size="sm" variant="soft" color="neutral">
                  Type: {formatSlicingProfileKind(kindFilter)}
                </Chip>
              )}
              <Button size="sm" variant="plain" color="neutral" onClick={clearFilters}>
                Clear filters
              </Button>
            </Stack>
          )}

          <DirectoryFiltersDialog
            open={filtersDialogOpen}
            title="Slicing profile filters"
            onClose={() => setFiltersDialogOpen(false)}
            onClear={clearFilters}
            clearDisabled={activeFilterCount === 0}
          >
            <FormControl>
              <FormLabel>Profile type</FormLabel>
              <Select<SlicingProfileKindFilter>
                size="sm"
                value={kindFilter}
                onChange={(_event, value) => {
                  setPage(0)
                  setKindFilter(value ?? 'all')
                }}
              >
                <Option value="all">All profile types</Option>
                <Option value="machine">Printer</Option>
                <Option value="process">Quality</Option>
                <Option value="filament">Material</Option>
              </Select>
            </FormControl>
          </DirectoryFiltersDialog>

          {filteredProfiles.length === 0 ? (
            <EmptyState
              compact
              icon={<SearchRoundedIcon />}
              title="No profiles match"
              description="No custom slicing profiles match the current search or filters."
              action={(search.trim().length > 0 || activeFilterCount > 0) ? (
                <Button size="sm" variant="plain" color="neutral" onClick={resetSearchAndFilters}>
                  Clear search and filters
                </Button>
              ) : undefined}
            />
          ) : (
            <PaginatedSection
              showingLabel={`Showing ${safePage * pageSize + 1}-${Math.min(sortedProfiles.length, (safePage + 1) * pageSize)} of ${sortedProfiles.length}`}
              previousDisabled={safePage === 0}
              nextDisabled={safePage >= pageCount - 1}
              onPrevious={() => setPage((current) => Math.max(0, current - 1))}
              onNext={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              spacing={1.25}
            >
              <Stack spacing={1}>
                {visibleProfiles.map((profile) => (
                  <SlicingProfileRow
                    key={profile.id}
                    profile={profile}
                    selectionMode={selectionMode}
                    selected={selectedProfileIdSet.has(profile.id)}
                    deleting={singleDeletingProfileId === profile.id}
                    onToggleSelected={() => toggleProfileSelection(profile.id)}
                    onDelete={() => void handleDeleteProfile(profile)}
                  />
                ))}
              </Stack>
            </PaginatedSection>
          )}
        </Stack>
      )}
    </Stack>
  )
}

function SlicingProfileRow({
  profile,
  selectionMode,
  selected,
  deleting,
  onToggleSelected,
  onDelete
}: {
  profile: SlicingProfileSummary
  selectionMode: boolean
  selected: boolean
  deleting: boolean
  onToggleSelected: () => void
  onDelete: () => void
}) {
  return (
    <Card variant="soft">
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
          <Stack direction="row" spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }} sx={{ minWidth: 0, flex: 1 }}>
            {selectionMode && (
              <Checkbox
                checked={selected}
                onChange={() => onToggleSelected()}
                slotProps={{ input: { 'aria-label': `Select ${profile.name}` } }}
              />
            )}
            <Stack spacing={0.35} sx={{ minWidth: 0, flex: 1 }}>
              <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Typography level="title-sm" sx={{ minWidth: 0 }}>{profile.name}</Typography>
                <Chip size="sm" variant="soft">{formatSlicingProfileKind(profile.kind)}</Chip>
              </Stack>
              {profile.updatedAt && (
                <Typography level="body-xs" textColor="text.tertiary">
                  Updated {new Date(profile.updatedAt).toLocaleString()}
                </Typography>
              )}
            </Stack>
          </Stack>
          {!selectionMode ? <Button size="sm" variant="plain" color="danger" loading={deleting} onClick={onDelete}>Delete</Button> : null}
        </Stack>
      </CardContent>
    </Card>
  )
}

function countProfilesByKind(profiles: SlicingProfileSummary[]): Record<SlicingProfileSummary['kind'], number> {
  return profiles.reduce<Record<SlicingProfileSummary['kind'], number>>((counts, profile) => {
    counts[profile.kind] += 1
    return counts
  }, { machine: 0, process: 0, filament: 0 })
}

async function buildSlicingProfileUpload(file: File, overwrite = false): Promise<UploadSlicingProfile> {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.json')) {
    return {
      fileName: file.name,
      encoding: 'utf8',
      content: await file.text(),
      overwrite
    }
  }

  return {
    fileName: file.name,
    encoding: 'base64',
    content: encodeFileBase64(new Uint8Array(await file.arrayBuffer())),
    overwrite
  }
}

function encodeFileBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function BridgeSettingsSection() {
  const queryClient = useQueryClient()
  const [connectCode, setConnectCode] = React.useState('')
  const [bridgeName, setBridgeName] = React.useState('')
  const bridgesQuery = useQuery({
    queryKey: ['settings-bridges'],
    queryFn: ({ signal }) => apiFetch<BridgeListResponse>('/api/bridges', { signal })
  })
  const connectBridge = useMutation({
    mutationFn: () => apiFetch<BridgeResponse>('/api/bridges/connect', {
      method: 'POST',
      body: {
        connectCode,
        ...(bridgeName.trim() ? { name: bridgeName.trim() } : {})
      }
    }),
    onSuccess: async () => {
      setConnectCode('')
      setBridgeName('')
      await invalidateBridgeQueries(queryClient)
    }
  })
  const bridges = bridgesQuery.data?.bridges ?? []
  const listError = bridgesQuery.error ? extractErrorMessage(bridgesQuery.error) : null
  const connectError = connectBridge.error ? extractErrorMessage(connectBridge.error) : null

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography level="title-md">Connect a bridge</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Enter the connect code shown by the local bridge container, then give the bridge a clear name.
        </Typography>
      </Box>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Connect code</FormLabel>
                <Input value={connectCode} onChange={(event) => setConnectCode(event.target.value)} />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Bridge name</FormLabel>
                <Input value={bridgeName} onChange={(event) => setBridgeName(event.target.value)} placeholder="Optional label" />
              </FormControl>
            </Stack>
            {connectError && <Alert color="danger">{connectError}</Alert>}
            <Stack direction="row" justifyContent="flex-end">
              <Button
                loading={connectBridge.isPending}
                disabled={!connectCode.trim()}
                onClick={() => connectBridge.mutate()}
              >
                Connect bridge
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Box>
        <Typography level="title-md">Bridges</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Review connected bridges and keep their names clear for library and printer routing.
        </Typography>
      </Box>

      {listError && <Alert color="danger">{listError}</Alert>}
      {!listError && bridges.length === 0 ? (
        <Alert color="neutral">No bridges are connected yet.</Alert>
      ) : (
        <Stack spacing={1}>
          {bridges.map((bridge) => (
            <BridgeSettingsRow key={bridge.id} bridge={bridge} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function BridgeSettingsRow({ bridge }: { bridge: BridgeSummary }) {
  const queryClient = useQueryClient()
  const [name, setName] = React.useState(bridge.name)
  const [removeOpen, setRemoveOpen] = React.useState(false)
  const [lastTestResult, setLastTestResult] = React.useState<BridgeTestResponse | null>(null)
  const [lastUpdateResult, setLastUpdateResult] = React.useState<BridgeUpdateActionResponse | null>(null)
  const renameBridge = useMutation({
    mutationFn: () => apiFetch<BridgeResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}`, {
      method: 'PATCH',
      body: { name: name.trim() }
    }),
    onSuccess: async () => {
      await invalidateBridgeQueries(queryClient)
    }
  })
  const removeBridge = useMutation({
    mutationFn: () => apiFetch<void>(`/api/bridges/${encodeURIComponent(bridge.id)}`, {
      method: 'DELETE'
    }),
    onSuccess: async () => {
      setRemoveOpen(false)
      await invalidateBridgeQueries(queryClient)
    }
  })
  const testBridge = useMutation({
    mutationFn: () => apiFetch<BridgeTestResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/test`, {
      method: 'POST'
    }),
    onSuccess: async (result) => {
      setLastTestResult(result)
      await invalidateBridgeQueries(queryClient)
    }
  })
  const checkBridgeUpdate = useMutation({
    mutationFn: () => apiFetch<BridgeUpdateActionResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/update/check`, {
      method: 'POST'
    }),
    onSuccess: async (result) => {
      setLastUpdateResult(result)
      await invalidateBridgeQueries(queryClient)
    }
  })
  const startBridgeUpdate = useMutation({
    mutationFn: () => apiFetch<BridgeUpdateActionResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/update/start`, {
      method: 'POST'
    }),
    onSuccess: async (result) => {
      setLastUpdateResult(result)
      await invalidateBridgeQueries(queryClient)
    }
  })
  const renameError = renameBridge.error ? extractErrorMessage(renameBridge.error) : null
  const testError = testBridge.error ? extractErrorMessage(testBridge.error) : null
  const updateError = checkBridgeUpdate.error
    ? extractErrorMessage(checkBridgeUpdate.error)
    : startBridgeUpdate.error
      ? extractErrorMessage(startBridgeUpdate.error)
      : null
  const removeError = removeBridge.error ? extractErrorMessage(removeBridge.error) : null
  const lastSeenLabel = bridge.lastSeenAt ? new Date(bridge.lastSeenAt).toLocaleString() : 'Not seen yet'
  const connectedAtLabel = bridge.connectionStats.connectedAt ? new Date(bridge.connectionStats.connectedAt).toLocaleString() : null
  const connectionStatItems = buildBridgeConnectionStatItems(bridge.connectionStats)
  const updateStatusLabel = formatBridgeUpdateStatus(bridge.update.status)
  const versionLabel = bridge.update.currentVersion
    ? `Version: ${bridge.update.currentVersion}`
    : 'Version: Unknown'
  const latestVersionLabel = bridge.update.latestVersion && bridge.update.latestVersion !== bridge.update.currentVersion
    ? `Latest: ${bridge.update.latestVersion}`
    : null
  const buildLabel = bridge.update.currentBuildRevision
    ? `Build: ${bridge.update.currentBuildRevision.slice(0, 12)}`
    : 'Build: Unknown'
  const latestBuildLabel = bridge.update.latestBuildRevision && bridge.update.latestBuildRevision !== bridge.update.currentBuildRevision
    ? `Latest build: ${bridge.update.latestBuildRevision.slice(0, 12)}`
    : null
  const runnerLabel = bridge.update.runnerAbiVersion
    ? `Runner: ${bridge.update.runnerAbiVersion}`
    : 'Runner: Unknown'
  const lastTestLabel = lastTestResult
    ? `Bridge responded in ${lastTestResult.responseTimeMs} ms at ${new Date(lastTestResult.respondedAt).toLocaleString()}.`
    : null
  const lastUpdateLabel = lastUpdateResult?.message ?? null
  const updateActionPending = checkBridgeUpdate.isPending || startBridgeUpdate.isPending
  const bridgeActionPending = renameBridge.isPending || removeBridge.isPending || testBridge.isPending || updateActionPending
  const canStartBridgeUpdate = bridge.update.status !== 'current' &&
    bridge.update.status !== 'imageUpdateRequired' &&
    bridge.update.status !== 'runnerUpdateRequired'
  const attachedPrinterLabel = bridge.printerCount === 1 ? '1 attached printer will be unassigned.' : `${bridge.printerCount} attached printers will be unassigned.`

  return (
    <>
      <Card variant="soft">
        <CardContent>
          <Stack spacing={1}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Bridge name</FormLabel>
                <Input value={name} onChange={(event) => setName(event.target.value)} disabled={removeBridge.isPending} />
              </FormControl>
              <Button
                loading={renameBridge.isPending}
                disabled={removeBridge.isPending || !name.trim() || name.trim() === bridge.name}
                onClick={() => renameBridge.mutate()}
              >
                Save name
              </Button>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
              <Stack spacing={0.75}>
                <Typography level="body-sm" textColor="text.tertiary">
                  Printers attached: {bridge.printerCount}
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} useFlexGap flexWrap="wrap">
                  <Typography level="body-sm" textColor="text.tertiary">
                    Update: {updateStatusLabel}
                  </Typography>
                  <Typography level="body-sm" textColor="text.tertiary">
                    {versionLabel}
                  </Typography>
                  {latestVersionLabel && (
                    <Typography level="body-sm" textColor="text.tertiary">
                      {latestVersionLabel}
                    </Typography>
                  )}
                  <Typography level="body-sm" textColor="text.tertiary">
                    {buildLabel}
                  </Typography>
                  {latestBuildLabel && (
                    <Typography level="body-sm" textColor="text.tertiary">
                      {latestBuildLabel}
                    </Typography>
                  )}
                  <Typography level="body-sm" textColor="text.tertiary">
                    Protocol: {bridge.update.protocolVersion ?? 'Unknown'}
                  </Typography>
                  <Typography level="body-sm" textColor="text.tertiary">
                    {runnerLabel}
                  </Typography>
                  <Typography level="body-sm" textColor="text.tertiary">
                    Channel: {bridge.update.channel}
                  </Typography>
                  {connectionStatItems.map((item) => (
                    <Typography key={item} level="body-sm" textColor="text.tertiary">
                      {item}
                    </Typography>
                  ))}
                  {connectedAtLabel && (
                    <Typography level="body-sm" textColor="text.tertiary">
                      Connected since: {connectedAtLabel}
                    </Typography>
                  )}
                  <Typography level="body-sm" textColor="text.tertiary">
                    Last seen: {lastSeenLabel}
                  </Typography>
                </Stack>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Button
                  variant="outlined"
                  loading={testBridge.isPending}
                  disabled={renameBridge.isPending || removeBridge.isPending}
                  onClick={() => {
                    testBridge.reset()
                    testBridge.mutate()
                  }}
                >
                  Test bridge
                </Button>
                <Button
                  variant="outlined"
                  loading={checkBridgeUpdate.isPending}
                  disabled={renameBridge.isPending || removeBridge.isPending || testBridge.isPending || startBridgeUpdate.isPending}
                  onClick={() => {
                    checkBridgeUpdate.reset()
                    startBridgeUpdate.reset()
                    checkBridgeUpdate.mutate()
                  }}
                >
                  Check updates
                </Button>
                <Button
                  variant="outlined"
                  loading={startBridgeUpdate.isPending}
                  disabled={!canStartBridgeUpdate || bridgeActionPending}
                  onClick={() => {
                    startBridgeUpdate.reset()
                    checkBridgeUpdate.reset()
                    startBridgeUpdate.mutate()
                  }}
                >
                  Update bridge
                </Button>
                <Button
                  variant="outlined"
                  color="danger"
                  disabled={bridgeActionPending}
                  onClick={() => {
                    removeBridge.reset()
                    setRemoveOpen(true)
                  }}
                >
                  Remove bridge
                </Button>
              </Stack>
            </Stack>
            {renameError && <Alert color="danger">{renameError}</Alert>}
            {testError && <Alert color="danger">{testError}</Alert>}
            {updateError && <Alert color="danger">{updateError}</Alert>}
            {bridge.update.lastError && <Alert color="warning">{bridge.update.lastError}</Alert>}
            {bridge.update.manualUpdateCommand && <Alert color="warning">Manual bridge update required: {bridge.update.manualUpdateCommand}</Alert>}
            {lastTestLabel && <Alert color="success">{lastTestLabel}</Alert>}
            {lastUpdateLabel && <Alert color="neutral">{lastUpdateLabel}</Alert>}
          </Stack>
        </CardContent>
      </Card>

      <ConfirmActionDialog
        open={removeOpen}
        title={`Remove ${bridge.name}?`}
        description={(
          <Stack spacing={1}>
            <Typography level="body-sm">
              Remove this bridge from the workspace. You can reconnect it later with its connect code.
            </Typography>
            {bridge.printerCount > 0 && (
              <Typography level="body-sm" textColor="text.tertiary">
                {attachedPrinterLabel}
              </Typography>
            )}
          </Stack>
        )}
        confirmLabel="Remove bridge"
        pending={removeBridge.isPending}
        error={removeError}
        onClose={() => {
          removeBridge.reset()
          setRemoveOpen(false)
        }}
        onConfirm={() => removeBridge.mutate()}
      />
    </>
  )
}

