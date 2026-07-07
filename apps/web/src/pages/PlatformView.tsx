import React from 'react'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import { Alert, Card, Stack, Typography } from '@mui/joy'
import { extractErrorMessage, type AppThemeSetting, type AuthManagementStatus } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { AuthAccessSection } from '../components/AuthAccessSection'
import { NestedViewHeader } from '../components/NestedViewHeader'
import { PluginManagerSection } from '../components/PluginManagerSection'
import { PlatformAuthSummarySection } from '../components/PlatformAuthSummarySection'
import { apiFetch } from '../lib/apiClient'
import { authQueryKeys, resolveAuthScope, useAuthBootstrapQuery } from '../lib/authQuery'
import { ThemeSettingCard } from '../components/settings/ThemeSettingCard'
import { resolveSettingsAuthState } from '../lib/settingsAuth'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { LogsPanel } from './LogsView'

type PlatformSubview = 'root' | 'general' | 'authentication' | 'plugins' | 'logs' | 'auth-users' | 'auth-roles'

/**
 * Dedicated workspace for platform-wide operations.
 *
 * The theme props mirror the workspace Settings view: the shared value is
 * the platform-scoped `/api/settings` record (the API stores tenantless
 * requests under a `platform:` key prefix) and the device override is the
 * platform-specific localStorage key owned by App.
 */
export function PlatformView({
  sharedAppTheme,
  deviceAppThemeOverride,
  sharedSettingsError,
  sharedSettingsSaving,
  sharedSettingsSaveError,
  onSetSharedAppTheme,
  onSetDeviceAppTheme,
  onClearDeviceAppThemeOverride
}: {
  sharedAppTheme: AppThemeSetting
  deviceAppThemeOverride: AppThemeSetting | null
  sharedSettingsError: string | null
  sharedSettingsSaving: boolean
  sharedSettingsSaveError: string | null
  onSetSharedAppTheme: (value: AppThemeSetting) => void
  onSetDeviceAppTheme: (value: AppThemeSetting) => void
  onClearDeviceAppThemeOverride: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const { authScopeKey } = resolveAuthScope(authBootstrapQuery.data)
  const authState = authBootstrapQuery.data
    ? resolveSettingsAuthState(authBootstrapQuery.data)
    : null
  const bootstrapCapabilities = authBootstrapQuery.data?.capabilities
  const authProviders = authState?.authProviders ?? []
  const showsAuthSetup = authState?.showsAuthSetup ?? false
  const canViewAuth = authState?.canViewAuth ?? false
  const canManageAuthProviders = authState?.canManageAuthProviders ?? false
  const showsAuthenticationSection = authState?.showsAuthenticationSection ?? false
  const canManageSettings = bootstrapCapabilities?.canManageSettings ?? false
  const canManageSupportAccess = bootstrapCapabilities?.canManageSupportAccess ?? false
  const canManagePlugins = bootstrapCapabilities?.canManagePlugins ?? false
  const canViewLogs = bootstrapCapabilities?.canViewLogs ?? false
  const authManagementStatusQuery = useQuery({
    queryKey: authQueryKeys.managementStatus(authScopeKey),
    queryFn: () => apiFetch<AuthManagementStatus>('/api/auth/status'),
    enabled: canViewAuth
  })
  const authManagementStatusError = authManagementStatusQuery.error
    ? extractErrorMessage(authManagementStatusQuery.error)
    : null

  const currentSubview = resolvePlatformSubview(location.pathname)
  const visibleSubview = resolveVisiblePlatformSubview(currentSubview, {
    showsAuthenticationSection,
    canViewAuth,
    canManagePlugins,
    canViewLogs
  })

  return (
    <Stack spacing={2}>
      {visibleSubview === 'root' && <Typography level="h3">Platform settings</Typography>}

      {visibleSubview === 'root' ? (
        <Stack spacing={1.5}>
          <PlatformOverviewCard
            title="General"
            description="Appearance and interface preferences for the platform workspace."
            onAction={() => navigate('/platform/settings/general')}
          />
          {showsAuthenticationSection && (
            <PlatformOverviewCard
              title="Authentication"
              description="Platform sign-in, platform roles, and provider configuration for the host workspace."
              onAction={() => navigate('/platform/settings/authentication')}
            />
          )}
          {canManagePlugins && (
            <PlatformOverviewCard
              title="Plugins"
              description="Manage platform-only plugins and control which tenant plugins are available in each workspace."
              onAction={() => navigate('/platform/settings/plugins')}
            />
          )}
          {canViewLogs && (
            <PlatformOverviewCard
              title="Logs"
              description="Audit activity first, with system logs available when you need deeper diagnostics."
              onAction={() => navigate('/platform/settings/logs')}
            />
          )}
        </Stack>
      ) : visibleSubview === 'general' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Platform settings', onClick: () => navigate('/platform/settings') },
              { label: 'General' }
            ]}
            description="Appearance and interface preferences for the platform workspace."
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
        </Stack>
      ) : visibleSubview === 'auth-users' || visibleSubview === 'auth-roles' ? (
        <Stack spacing={2}>
          <NestedViewHeader
            crumbs={[
              { label: 'Platform settings', onClick: () => navigate('/platform/settings') },
              { label: 'Authentication', onClick: () => navigate('/platform/settings/authentication') },
              { label: visibleSubview === 'auth-users' ? 'Platform users' : 'Platform roles' }
            ]}
            description={visibleSubview === 'auth-users'
              ? 'Manage platform users. Workspace access depends on each workspace support-access policy unless a platform role grants bypass.'
              : 'Manage platform-level roles and their permissions.'}
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
            onOpenUsers={() => navigate('/platform/settings/auth/users')}
            onOpenRoles={() => navigate('/platform/settings/auth/roles')}
          />
        </Stack>
      ) : visibleSubview === 'authentication' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Platform settings', onClick: () => navigate('/platform/settings') },
              { label: 'Authentication' }
            ]}
            description="Platform sign-in, platform roles, and provider configuration for the host workspace."
          />

          {showsAuthenticationSection ? (
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

              {showsAuthSetup && (
                <StaticPluginSlot
                  name="settings.authenticationSetup"
                  context={{
                    authProviders,
                    authSetupRequired: authBootstrapQuery.data?.setupRequired ?? false,
                    authBootstrapReady: authBootstrapQuery.isSuccess,
                    authTenantId: undefined,
                    authScopeKey,
                    authHost: 'settings',
                    actorType: authBootstrapQuery.data?.actor.type ?? 'anonymous',
                    canManageAuthProviders
                  }}
                />
              )}

              {(canViewAuth || canManageAuthProviders) && (
                <Stack spacing={1.5}>
                  <PlatformAuthSummarySection authBootstrap={authBootstrapQuery.data} authProviders={authProviders} />
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
                      onOpenUsers={() => navigate('/platform/settings/auth/users')}
                      onOpenRoles={() => navigate('/platform/settings/auth/roles')}
                    />
                  )}
                </Stack>
              )}
            </Stack>
          ) : (
            <Typography level="body-sm" textColor="text.secondary">
              Install and enable an auth plugin to configure platform sign-in.
            </Typography>
          )}
        </Stack>
      ) : visibleSubview === 'plugins' ? (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Platform settings', onClick: () => navigate('/platform/settings') },
              { label: 'Plugins' }
            ]}
            description="Manage platform-only plugins and control which tenant plugins are available in each workspace."
          />
          <PluginManagerSection surface="platform" />
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          <NestedViewHeader
            crumbs={[
              { label: 'Platform settings', onClick: () => navigate('/platform/settings') },
              { label: 'Logs' }
            ]}
            description="Audit activity first, with system logs available when you need deeper diagnostics."
          />
          <LogsPanel embedded surface="platform" />
        </Stack>
      )}
    </Stack>
  )
}

function resolvePlatformSubview(pathname: string): PlatformSubview {
  if (pathname === '/platform/settings' || pathname === '/platform/settings/') return 'root'
  if (pathname === '/platform/settings/general') return 'general'
  if (pathname === '/platform/settings/authentication') return 'authentication'
  if (pathname === '/platform/settings/plugins') return 'plugins'
  if (pathname === '/platform/settings/logs') return 'logs'
  if (pathname === '/platform/settings/auth/users') return 'auth-users'
  if (pathname === '/platform/settings/auth/roles') return 'auth-roles'
  return 'root'
}

function resolveVisiblePlatformSubview(
  subview: PlatformSubview,
  options: {
    showsAuthenticationSection: boolean
    canViewAuth: boolean
    canManagePlugins: boolean
    canViewLogs: boolean
  }
): PlatformSubview {
  if (subview === 'authentication' && !options.showsAuthenticationSection) return 'root'
  if ((subview === 'auth-users' || subview === 'auth-roles') && !options.showsAuthenticationSection) return 'root'
  if ((subview === 'auth-users' || subview === 'auth-roles') && !options.canViewAuth) return 'authentication'
  if (subview === 'plugins' && !options.canManagePlugins) return 'root'
  if (subview === 'logs' && !options.canViewLogs) return 'root'
  return subview
}

function PlatformOverviewCard({
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