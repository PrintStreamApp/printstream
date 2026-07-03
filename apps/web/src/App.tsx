import { Alert, Box, Button, Stack, Typography } from '@mui/joy'
import CssBaseline from '@mui/joy/CssBaseline'
import { CssVarsProvider } from '@mui/joy/styles'
import AccountCircleRoundedIcon from '@mui/icons-material/AccountCircleRounded'
import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import ExtensionRoundedIcon from '@mui/icons-material/ExtensionRounded'
import FolderCopyRoundedIcon from '@mui/icons-material/FolderCopyRounded'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  AUTH_ACCESS_VIEW_PERMISSION,
  JOBS_VIEW_PERMISSION,
  LIBRARY_MANAGE_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  SETTINGS_MANAGE_PERMISSION,
  TENANTS_DISABLE_PERMISSION,
  TENANTS_MANAGE_PERMISSION,
  PUBLIC_DEMO_TENANT_SLUG,
  DEFAULT_APP_LANDING_PAGE,
  extractErrorMessage,
  type AppLandingPageSetting,
  type AppThemeSetting,
  type GeneralSettings,
  type Permission,
  type UpdateGeneralSettingsInput
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppShell, type ShellTab } from './components/AppShell'
import {
  DEVICE_APP_THEME_OVERRIDE_KEY,
  DEVICE_LANDING_PAGE_OVERRIDE_KEY_PREFIX,
  DEVICE_NAV_TAB_ORDER_OVERRIDE_KEY_PREFIX,
  DEVICE_UNCONSTRAINED_WIDTH_OVERRIDE_KEY,
  catchAllRouteDecision,
  parseNullableAppLandingPageSetting,
  parseNullableAppThemeSetting,
  parseNullableBoolean,
  parseNullableNavTabOrder,
  tenantScopedRoutePath
} from './appShellHelpers'
import { orderNavTabs } from './lib/navTabOrder'
import { marketingModule, platformAdminModule } from './lib/privateModules'
import { BridgeUpdateBanner } from './components/BridgeUpdateBanner'
import { LicenseBanner } from './components/LicenseBanner'
import { BridgeCrashBanner } from './components/BridgeCrashBanner'
import { BridgeDebugCaptureBanner } from './components/BridgeDebugCaptureBanner'
import { LibraryUploadPanel } from './components/LibraryUploadPanel'
import { DevRuntimeStatus } from './components/DevRuntimeStatus'
import { AppVersionFooter } from './components/AppVersionFooter'
import { HelpFeedbackButton } from './components/HelpFeedbackButton'
import { PluginSlot } from './plugin/PluginSlot'
import { DeleteOperationToasts } from './components/DeleteOperationToasts'
import { DispatchToasts } from './components/DispatchToasts'
import { SlicingToasts } from './components/SlicingToasts'
import { Printer3dRoundedIcon } from './components/Printer3dRoundedIcon'
import { StatusToastStack } from './components/StatusToast'
import { Toaster } from './components/Toaster'
import { PrintDispatchJobsQueryProvider, usePrintDispatchJobs } from './hooks/usePrintDispatchJobs'
import { usePrinterWebSocket } from './hooks/usePrinterWebSocket'
import { useLocalStorageState } from './hooks/useLocalStorageState'
import { apiFetch } from './lib/apiClient'
import { AuthBootstrapQueryProvider, buildAuthBootstrapQueryOptions } from './lib/authQuery'
import { resolveAuthRouteState, resolveProtectedRouteState, shouldShowAccountTab, shouldShowWorkspaceSwitcher, shouldUsePlatformAuthTheme } from './lib/authRoute'
import { getBrowserEnv } from './lib/browserEnv'
import { buildDocumentTitle, getDeploymentEnvironment } from './lib/deploymentEnvironment'
import { publishAuthBootstrapData, publishPluginCatalogData } from './lib/appShellQueryData'
import { PluginCatalogQueryProvider, usePluginCatalogQuery } from './lib/pluginCatalogQuery'
import { isTenantWorkspaceLandingReady, pluginBasePath, resolveDefaultWorkspaceRoute, resolveTenantRouteRedirect, resolveTenantWorkspaceLandingPath, resolveWorkspaceSwitchDestination, shouldClearPendingWorkspaceRoute } from './lib/workspaceSwitch'
import { buildPlatformWorkspacePath, buildTenantWorkspacePath, buildWorkspaceSelectionPath, isPlatformWorkspacePath, isTenantWorkspaceCandidatePath, parseWorkspacePathname } from './lib/workspaceRoute'
import {
  isPluginActiveByName,
  pluginSupportsRuntimeSurface
} from './lib/pluginSettings'
import { runtimePolicyContext } from './lib/runtimePolicy'
import { completeSplashScreen } from './lib/splashScreen'
import { toast } from './lib/toast'
import { resolveShellIdentity } from './lib/authUi'
import { countAccessibleWorkspaceChoices, countSwitchableWorkspaceChoices, listAccessibleTenantWorkspaces } from './lib/workspaceAccess'
import { readWorkspaceContextHint } from './lib/workspaceContext'
import { JobsView } from './pages/JobsView'
import { LibraryView } from './pages/LibraryView'
import { PrintersView } from './pages/PrintersView'
import { AccountView } from './pages/AccountView'
import { AuthView } from './pages/AuthView'
import { PlatformView } from './pages/PlatformView'
import { SettingsView } from './pages/SettingsView'
import { GetStartedView } from './pages/GetStartedView'
import { TenantStatsView } from './pages/TenantStatsView'
import { WorkspaceSelectionView } from './pages/WorkspaceSelectionView'
import { ConnectBridgeView } from './pages/ConnectBridgeView'
import { stashPendingBridgeConnectCode } from './lib/pendingBridgeConnect'
import { CORE_LANDING_PAGE_OPTIONS } from './lib/landingPageOptions'
import { webPluginRegistry } from './plugin/registry'
import { registerBuiltinPlugins } from './plugin/builtin'
import { buildChromeCssVars } from './theme/buildTheme'
import { auroraChrome, auroraTheme, defaultChrome, theme } from './theme/theme'
import { platformAuroraChrome, platformAuroraTheme, platformChrome, platformTheme } from './theme/platformTheme'

const baseCoreTabs: ReadonlyArray<ShellTab> = [
  { value: '/get-started', label: 'Get started', mobileIcon: <ChecklistRoundedIcon /> },
  { value: '/printers', label: 'Printers', mobileIcon: <Printer3dRoundedIcon /> },
  { value: '/library', label: 'Library', mobileIcon: <FolderCopyRoundedIcon /> },
  { value: '/jobs', label: 'Jobs', mobileIcon: <HistoryRoundedIcon /> },
  { value: '/stats', label: 'Stats', mobileIcon: <QueryStatsRoundedIcon /> },
  {
    value: '/settings',
    label: 'Settings',
    ariaLabel: 'Settings',
    icon: <SettingsRoundedIcon />,
    mobileIcon: <SettingsRoundedIcon />,
    iconOnly: true
  }
]

// Default left-to-right order for the leading plugin tabs (Queue, then Orders);
// any other plugin tab falls back to alphabetical after these. The final
// interleaving with core tabs is governed by DEFAULT_NAV_TAB_ORDER.
const PLUGIN_TAB_DEFAULT_ORDER: readonly string[] = ['/queue', '/orders']

// Register built-in plugins when this (lazy-loaded) app-shell chunk first loads — moved out of
// main.tsx so a cold load of a marketing page never pulls in the plugin graph. Runs once at module
// import, before <App> first renders (which reads webPluginRegistry.routes()).
registerBuiltinPlugins()

const webRuntimeStartedAt = new Date().toISOString()

interface DevHealthResponse {
  ok: true
  time: string
  runtime?: {
    nodeEnv: string
    bootId: string
    startedAt: string
    uptimeSeconds: number
  }
}

export function App() {
  const queryClient = useQueryClient()
  const browserEnv = getBrowserEnv()
  // Tag non-production deployments in the page title so an open tab is
  // unmistakable (e.g. "[staging] PrintStream"); production stays bare.
  useEffect(() => {
    const hostname = typeof window !== 'undefined' ? window.location.hostname : ''
    document.title = buildDocumentTitle(getDeploymentEnvironment(hostname, browserEnv.devMode))
  }, [browserEnv.devMode])
  const location = useLocation()
  const navigate = useNavigate()
  const workspacePath = parseWorkspacePathname(location.pathname)
  const routeTenantSlug = workspacePath.tenantSlug
  const appPathname = workspacePath.appPathname
  const routePlatformWorkspace = isPlatformWorkspacePath(location.pathname)
  const authBootstrapScopeKey = routeTenantSlug ? `tenant:${routeTenantSlug}` : routePlatformWorkspace ? 'platform' : 'ambient'
  const previousWorkspaceScopeKey = useRef(authBootstrapScopeKey)
  const [pendingWorkspaceRoute, setPendingWorkspaceRoute] = useState<{
    routePath: string
    targetTenantId: string | null
    sourcePathname: string
  } | null>(null)
  const invalidateWorkspaceShellQueries = useMemo(() => async () => {
    toast.clear()
    queryClient.removeQueries({
      predicate: (query) => {
        const queryNamespace = typeof query.queryKey[0] === 'string' ? query.queryKey[0] : null
        return queryNamespace !== 'auth-bootstrap'
          && queryNamespace !== 'general-settings'
          && queryNamespace !== 'dev-health'
      }
    })

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
      queryClient.invalidateQueries({ queryKey: ['plugin-catalog'] }),
      queryClient.invalidateQueries({ queryKey: ['general-settings'] })
    ])
  }, [queryClient])
  const authBootstrapQuery = useQuery(buildAuthBootstrapQueryOptions(authBootstrapScopeKey))
  useEffect(() => {
    if (previousWorkspaceScopeKey.current === authBootstrapScopeKey) return
    previousWorkspaceScopeKey.current = authBootstrapScopeKey
    void invalidateWorkspaceShellQueries()
  }, [authBootstrapScopeKey, invalidateWorkspaceShellQueries])
  const devHealthQuery = useQuery({
    queryKey: ['dev-health'],
    queryFn: ({ signal }) => apiFetch<DevHealthResponse>('/api/health', { signal }),
    enabled: browserEnv.devMode,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalErrorToast: true }
  })
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const authBootstrapReady = authBootstrapQuery.isSuccess
  const authSetupRequired = authBootstrapQuery.data?.setupRequired ?? false
  const hasTenantContext = authBootstrapQuery.data?.tenant != null
  const actorType = authBootstrapQuery.data?.actor.type ?? 'anonymous'
  const isPlatformUser = authBootstrapQuery.data?.actor.type === 'user' && (authBootstrapQuery.data.actor.isPlatformUser ?? false)
  // Self-hosted (OSS) deployments hide the cloud-only platform-admin and
  // marketing surfaces even when their private modules are present (a developer
  // running the private tree with SELF_HOSTED=true). In a real public build the
  // modules are already absent, so these stay null regardless.
  const selfHostedDeployment = authBootstrapQuery.data?.runtimePolicy.selfHosted ?? false
  const platformAdmin = selfHostedDeployment ? null : platformAdminModule
  const marketing = selfHostedDeployment ? null : marketingModule
  const canUsePlatformWorkspace = isPlatformUser
  const inPlatformMode = canUsePlatformWorkspace && !hasTenantContext
  const isAuthenticated = actorType !== 'anonymous'
  const authProviderSetupAvailable = authBootstrapReady
    && !hasTenantContext
    && !authEnabled
    && !isAuthenticated
    && (authBootstrapQuery.data?.providers.length ?? 0) > 0
  const grantedPermissions = authBootstrapQuery.data?.permissions ?? []
  const memberTenantOptions = useMemo(
    () => listAccessibleTenantWorkspaces(authBootstrapQuery.data?.memberTenants ?? []),
    [authBootstrapQuery.data?.memberTenants]
  )
  const availableTenantOptions = useMemo(
    () => listAccessibleTenantWorkspaces(authBootstrapQuery.data?.availableTenants ?? []),
    [authBootstrapQuery.data?.availableTenants]
  )
  const memberTenantIds = useMemo(
    () => new Set(memberTenantOptions.map((tenant) => tenant.id)),
    [memberTenantOptions]
  )
  const switchableTenantOptions = memberTenantOptions
  const tenantDirectoryAccessibleTenantIds = useMemo(
    () => new Set(availableTenantOptions.map((tenant) => tenant.id)),
    [availableTenantOptions]
  )
  const workspaceChoiceCount = useMemo(
    () => countAccessibleWorkspaceChoices({
      tenants: switchableTenantOptions,
      includePlatform: canUsePlatformWorkspace
    }),
    [switchableTenantOptions, canUsePlatformWorkspace]
  )
  const activeTenantId = authBootstrapQuery.data?.tenant?.id ?? null
  const activeTenantSlug = authBootstrapQuery.data?.tenant?.slug ?? null
  const switchableWorkspaceChoiceCount = useMemo(
    () => countSwitchableWorkspaceChoices({
      tenants: switchableTenantOptions,
      includePlatform: canUsePlatformWorkspace,
      activeTenantId
    }),
    [activeTenantId, switchableTenantOptions, canUsePlatformWorkspace]
  )
  const tenantSlugById = useMemo(
    () => new Map([...availableTenantOptions, ...switchableTenantOptions].map((tenant) => [tenant.id, tenant.slug] as const)),
    [availableTenantOptions, switchableTenantOptions]
  )
  const hasPermission = (permission: Permission) => grantedPermissions.includes(permission)
  const canViewAuth = hasPermission(AUTH_ACCESS_VIEW_PERMISSION)
  const canManageSettings = hasPermission(SETTINGS_MANAGE_PERMISSION)
  const canDisableTenants = hasPermission(TENANTS_DISABLE_PERMISSION)
  const canManageTenants = hasPermission(TENANTS_MANAGE_PERMISSION)
  const isTenantAuthSettingsRoute = appPathname === '/settings/authentication' || appPathname.startsWith('/settings/auth/')
  const canOpenTenantAuthSettings = hasTenantContext && canViewAuth
  const canOpenTenantSettings = canManageSettings || canManageTenants || canOpenTenantAuthSettings
  const canManageLibrary = hasPermission(LIBRARY_MANAGE_PERMISSION)
  const canUploadLibrary = hasPermission(LIBRARY_UPLOAD_PERMISSION)
  const canManagePrinters = hasPermission(PRINTERS_MANAGE_PERMISSION)
  usePrinterWebSocket(
    authBootstrapReady
      && (isAuthenticated || (hasTenantContext && !authEnabled))
      && (routeTenantSlug != null || routePlatformWorkspace),
    routeTenantSlug ? `tenant:${routeTenantSlug}` : 'platform'
  )
  const [deviceUnconstrainedWidthOverride, setDeviceUnconstrainedWidthOverride] = useLocalStorageState<boolean | null>(
    DEVICE_UNCONSTRAINED_WIDTH_OVERRIDE_KEY,
    null,
    parseNullableBoolean
  )
  const [deviceAppThemeOverride, setDeviceAppThemeOverride] = useLocalStorageState<AppThemeSetting | null>(
    DEVICE_APP_THEME_OVERRIDE_KEY,
    null,
    parseNullableAppThemeSetting
  )
  const deviceLandingPageOverrideKey = `${DEVICE_LANDING_PAGE_OVERRIDE_KEY_PREFIX}.${activeTenantSlug ?? routeTenantSlug ?? 'ambient'}`
  const [deviceLandingPageOverride, setDeviceLandingPageOverride, deviceLandingPageOverrideLoaded] = useLocalStorageState<AppLandingPageSetting | null>(
    deviceLandingPageOverrideKey,
    null,
    parseNullableAppLandingPageSetting
  )
  const deviceNavTabOrderOverrideKey = `${DEVICE_NAV_TAB_ORDER_OVERRIDE_KEY_PREFIX}.${activeTenantSlug ?? routeTenantSlug ?? 'ambient'}`
  const [deviceNavTabOrderOverride, setDeviceNavTabOrderOverride] = useLocalStorageState<string[] | null>(
    deviceNavTabOrderOverrideKey,
    null,
    parseNullableNavTabOrder
  )
  const pluginStateQuery = usePluginCatalogQuery({
    enabled: authBootstrapQuery.isSuccess ? (isAuthenticated || (hasTenantContext && !authEnabled)) : false,
    suppressGlobalErrorToast: true
  })
  useEffect(() => {
    if (authBootstrapQuery.data) {
      publishAuthBootstrapData(authBootstrapQuery.data)
    }
  }, [authBootstrapQuery.data])
  useEffect(() => {
    if (pluginStateQuery.data) {
      publishPluginCatalogData(pluginStateQuery.data)
    }
  }, [pluginStateQuery.data])
  const generalSettingsQuery = useQuery({
    queryKey: ['general-settings'],
    queryFn: ({ signal }) => apiFetch<GeneralSettings>('/api/settings', { signal })
  })
  // Treat as dismissed until settings load so the tab/landing never flash in.
  const quickStartDismissed = generalSettingsQuery.data?.quickStartDismissed ?? true
  const updateGeneralSettings = useMutation({
    mutationFn: (input: UpdateGeneralSettingsInput) =>
      apiFetch<GeneralSettings>('/api/settings', { method: 'PUT', body: input }),
    onSuccess: (data) => {
      queryClient.setQueryData(['general-settings'], data)
    }
  })
  const switchTenant = useMutation({
    mutationFn: ({ tenantId }: { tenantId: string; tenantSlug: string; routePath: string }) => apiFetch<void>('/api/auth/switch-tenant', {
      method: 'POST',
      body: { tenantId }
    }),
    onSuccess: async (_data, variables) => {
      const nextRoute = buildTenantWorkspacePath(variables.tenantSlug, variables.routePath)
      if (nextRoute !== currentRoute) {
        navigate(nextRoute, { replace: true })
      }
      await invalidateWorkspaceShellQueries()
    }
  })
  const selectTenantContext = useMutation({
    mutationFn: ({ tenantId }: { tenantId: string | null; tenantSlug?: string; routePath: string }) => apiFetch<void>('/api/auth/tenant-context', {
      method: 'POST',
      body: { tenantId }
    }),
    onSuccess: async (_data, variables) => {
      if (variables.tenantId == null) {
        if (variables.routePath !== currentRoute) {
          navigate(variables.routePath, { replace: true })
        }
        await invalidateWorkspaceShellQueries()
      } else if (variables.tenantSlug) {
        const nextRoute = buildTenantWorkspacePath(variables.tenantSlug, variables.routePath)
        if (nextRoute !== currentRoute) {
          navigate(nextRoute, { replace: true })
        }
        await invalidateWorkspaceShellQueries()
      }
    }
  })
  // The plugin registry is static for the page's lifetime, but routes() allocates
  // a fresh array of fresh objects each call. Memoize it so the downstream tab
  // memo chain (pluginRoutes -> pluginTabs -> tabs) isn't invalidated every render.
  const allPluginRoutes = useMemo(() => webPluginRegistry.routes(), [])
  const currentPluginSurface = inPlatformMode ? 'platform' : 'tenant'
  const apiPluginsByName = useMemo(
    () => new Map((pluginStateQuery.data?.plugins ?? []).map((plugin) => [plugin.name, plugin] as const)),
    [pluginStateQuery.data?.plugins]
  )
  const pluginRoutes = useMemo(
    () => allPluginRoutes
      .filter((route) => pluginSupportsRuntimeSurface(route, currentPluginSurface))
      .filter((route) => isPluginActiveByName(route.pluginName, apiPluginsByName, pluginStateQuery.data?.plugins != null)),
    [allPluginRoutes, apiPluginsByName, currentPluginSurface, pluginStateQuery.data?.plugins]
  )
  const pluginTabs = useMemo<ReadonlyArray<ShellTab>>(
    () => pluginRoutes
      .filter((route) => Boolean(route.navLabel))
      .map((route) => {
        const tabValue = pluginBasePath(route.path)
        const mobileIcon = route.navMobileIcon
          ?? (tabValue === '/orders' ? <ChecklistRoundedIcon /> : <ExtensionRoundedIcon />)
        return { value: tabValue, label: route.navLabel ?? tabValue, mobileIcon }
      })
      .sort((left, right) => {
        // Pinned default order for the first plugin tabs; everything else alphabetical.
        const leftRank = PLUGIN_TAB_DEFAULT_ORDER.indexOf(left.value)
        const rightRank = PLUGIN_TAB_DEFAULT_ORDER.indexOf(right.value)
        if (leftRank !== -1 || rightRank !== -1) {
          if (leftRank === -1) return 1
          if (rightRank === -1) return -1
          return leftRank - rightRank
        }
        return left.label.localeCompare(right.label)
      }),
    [pluginRoutes]
  )
  const canViewPrinters = hasPermission(PRINTERS_VIEW_PERMISSION)
  const canViewLibrary = hasPermission(LIBRARY_VIEW_PERMISSION)
  const canViewJobs = hasPermission(JOBS_VIEW_PERMISSION)
  const shellDispatchQuery = usePrintDispatchJobs({
    enabled: authBootstrapReady && hasTenantContext && isAuthenticated && canViewJobs,
    idleRefetchInterval: 10_000,
    suppressGlobalErrorToast: true
  })
  const showsAccountTab = shouldShowAccountTab({
    authBootstrapReady,
    actorType,
    activeTenantId,
    memberTenantIds
  })
  const enabledPluginBasePaths = useMemo(
    () => pluginRoutes.map((route) => pluginBasePath(route.path)),
    [pluginRoutes]
  )
  const disabledActivePluginRoute = useMemo(
    () => {
      if (!pluginStateQuery.data?.plugins) return null
      return allPluginRoutes.find((route) => {
        if (!pluginSupportsRuntimeSurface(route, currentPluginSurface)) return false
        if (isPluginActiveByName(route.pluginName, apiPluginsByName, true)) return false
        return appPathname.startsWith(pluginBasePath(route.path))
      }) ?? null
    },
    [allPluginRoutes, apiPluginsByName, appPathname, currentPluginSurface, pluginStateQuery.data?.plugins]
  )
  // Plugin routes (e.g. /queue) are only mounted once the plugin catalog query resolves, which itself
  // can't start until auth bootstrap finishes. On a hard refresh of a plugin route that determination is
  // still in flight at first paint, so the route isn't in the tree yet. Track whether the current path is
  // a known plugin route and whether the catalog is still resolving, so the catch-all below can wait
  // instead of redirecting the refresh to home before the plugin route can appear.
  const appPathIsKnownPluginRoute = useMemo(
    () => allPluginRoutes.some((route) =>
      pluginSupportsRuntimeSurface(route, currentPluginSurface) && appPathname.startsWith(pluginBasePath(route.path))),
    [allPluginRoutes, appPathname, currentPluginSurface]
  )
  const hasPluginState = pluginStateQuery.data?.plugins != null
  const pluginCatalogEnabled = authBootstrapReady && (isAuthenticated || (hasTenantContext && !authEnabled))
  const pluginCatalogResolving = !hasPluginState && !pluginStateQuery.isError
    && (authBootstrapQuery.isPending || pluginCatalogEnabled)
  const catchAllDecision = catchAllRouteDecision({
    isKnownPluginRoute: appPathIsKnownPluginRoute,
    pluginCatalogResolving,
    hasPluginState
  })
  const coreTabs = useMemo<ReadonlyArray<ShellTab>>(
    () => {
      if (!authBootstrapReady) return []
      if (inPlatformMode) return []
      return baseCoreTabs.filter((tab) => {
        if (tab.value === '/get-started') return hasTenantContext && !quickStartDismissed
        if (tab.value === '/printers') return hasTenantContext && canViewPrinters
        if (tab.value === '/library') return hasTenantContext && canViewLibrary
        if (tab.value === '/jobs') return hasTenantContext && canViewJobs
        if (tab.value === '/settings') return canManageSettings || canManageTenants
        return true
      })
    },
    [authBootstrapReady, canManageSettings, canManageTenants, canViewJobs, canViewLibrary, canViewPrinters, hasTenantContext, inPlatformMode, quickStartDismissed]
  )
  const platformTabs = useMemo<ReadonlyArray<ShellTab>>(
    () => inPlatformMode
      ? [
          ...(platformAdmin?.navTabs ?? []),
          {
            value: '/platform/settings',
            label: 'Settings',
            ariaLabel: 'Settings',
            icon: <SettingsRoundedIcon />,
            mobileIcon: <SettingsRoundedIcon />,
            iconOnly: true
          }
        ]
      : [],
    [inPlatformMode, platformAdmin]
  )
  const accountTab = useMemo<ShellTab | null>(
    () => showsAccountTab
      ? {
          value: inPlatformMode ? '/platform/account' : '/account',
          label: 'Account',
          ariaLabel: 'Account',
          icon: <AccountCircleRoundedIcon />,
          iconOnly: true
        }
      : null,
    [inPlatformMode, showsAccountTab]
  )
  const workspaceContextHint = readWorkspaceContextHint()
  const canUseWorkspaceChooser = authBootstrapReady && isAuthenticated && switchableWorkspaceChoiceCount > 0
  const requiresWorkspaceSelection = authBootstrapReady
    && isAuthenticated
    && !hasTenantContext
    && workspaceChoiceCount > 1
    && !(workspaceContextHint?.type === 'platform' && canUsePlatformWorkspace)
  const sharedLandingPage = generalSettingsQuery.data?.landingPage ?? DEFAULT_APP_LANDING_PAGE
  const effectiveLandingPage = deviceLandingPageOverride ?? sharedLandingPage
  const landingPageOptions = useMemo(
    () => {
      const options = [...CORE_LANDING_PAGE_OPTIONS]
      const seen = new Set(options.map((option) => option.value))
      for (const tab of pluginTabs) {
        if (seen.has(tab.value)) {
          continue
        }
        options.push({ value: tab.value, label: tab.label })
        seen.add(tab.value)
      }
      return options
    },
    [pluginTabs]
  )
  // A workspace that has not finished onboarding lands on Get started; the
  // configured landing page takes over once the page is dismissed.
  const tenantWorkspaceLandingRoute = !quickStartDismissed
    ? '/get-started'
    : resolveTenantWorkspaceLandingPath({
        preferredPage: effectiveLandingPage,
        canViewPrinters,
        canViewLibrary,
        canViewJobs,
        canOpenSettings: canOpenTenantSettings,
        enabledPluginBasePaths
      })
  const tenantWorkspaceEntryRoute = '/'
  const defaultTab = requiresWorkspaceSelection ? buildWorkspaceSelectionPath() : inPlatformMode ? buildPlatformWorkspacePath() : tenantWorkspaceLandingRoute
  const defaultRoute = resolveDefaultWorkspaceRoute({
    activeTenantSlug,
    defaultPath: defaultTab
  })
  const runtimePolicy = useMemo(
    () => ({
      demoMode: authBootstrapQuery.data?.runtimePolicy.demoMode ?? false,
      managedBridge: authBootstrapQuery.data?.runtimePolicy.managedBridge ?? false,
      selfHosted: authBootstrapQuery.data?.runtimePolicy.selfHosted ?? false
    }),
    [
      authBootstrapQuery.data?.runtimePolicy.demoMode,
      authBootstrapQuery.data?.runtimePolicy.managedBridge,
      authBootstrapQuery.data?.runtimePolicy.selfHosted
    ]
  )
  const shellIdentity = useMemo(
    () => authBootstrapQuery.data ? resolveShellIdentity(authBootstrapQuery.data.actor) : null,
    [authBootstrapQuery.data]
  )
  const currentWorkspaceChooserLabel = authBootstrapQuery.data?.tenant?.name ?? (inPlatformMode ? 'Platform' : undefined)
  const currentRoute = `${location.pathname}${location.search}${location.hash}`
  // Connect-bridge deep link (`/connect-bridge?code=…`): workspace-agnostic, so
  // the bridge can build it without knowing the tenant slug.
  const connectBridgeCode = appPathname === '/connect-bridge'
    ? new URLSearchParams(location.search).get('code')
    : null
  const tenantlessRedirect = buildWorkspaceSelectionPath()
  const workspaceSwitchPending = switchTenant.isPending || selectTenantContext.isPending
  const platformWorkspaceLandingRoute = buildPlatformWorkspacePath()
  const publicDemoLandingRoute = buildTenantWorkspacePath(PUBLIC_DEMO_TENANT_SLUG, '/printers')
  const isWorkspaceSelectionRoute = routeTenantSlug == null && appPathname === buildWorkspaceSelectionPath()
  // The connect-bridge deep link is a focused, workspace-agnostic landing — show
  // it with the same clean chrome as the workspace chooser (no tabs/workspace
  // label), not wrapped in the tenant or platform shell.
  const isConnectBridgeRoute = routeTenantSlug == null && appPathname === '/connect-bridge'
  // Marketing/public routes come from the optional private marketing module.
  // Without it (public open-source builds) none of these flags fire and `/`
  // falls through to the in-app landing redirect.
  const marketingRoutes = marketing?.routes ?? []
  const isMarketingRoute = routeTenantSlug == null && appPathname === '/' && marketing != null
  const isPublicInfoRoute = routeTenantSlug == null
    && marketingRoutes.some((route) => route.publicChrome && route.path !== '/' && route.path === appPathname)
  // Marketing-module routes must skip the top-level auth gate: a cached ambient
  // bootstrap reports global auth enabled, which would otherwise render the
  // sign-in wall synchronously before the route element can run.
  const isPrivatePublicRoute = routeTenantSlug == null && marketingRoutes.some((route) => route.path === appPathname)
  const tenantLandingRouteReady = isTenantWorkspaceLandingReady({
    routeTenantSlug,
    activeTenantSlug,
    authBootstrapReady,
    sharedSettingsReady: generalSettingsQuery.data != null,
    deviceLandingPageOverrideLoaded
  })
  const authRouteState = resolveAuthRouteState({
    authBootstrapReady,
    authEnabled,
    authSetupRequired,
    authProviderSetupAvailable,
    allowSetup: !hasTenantContext,
    isAuthenticated
  })
  const tenantRouteRedirect = routeTenantSlug != null
    && authBootstrapReady
    && authRouteState !== 'auth'
    && (activeTenantSlug == null || activeTenantSlug !== routeTenantSlug)
    ? tenantlessRedirect
    : resolveTenantRouteRedirect({
        authBootstrapReady,
        hasTenantContext,
        tenantlessRedirect
      })
  const showsWorkspaceSwitcher = shouldShowWorkspaceSwitcher({
    authRouteState,
    requestedTenantSlug: routeTenantSlug,
    activeTenantSlug
  })
  const workspaceChooserTab = useMemo<ShellTab | null>(
    () => (canUseWorkspaceChooser && showsWorkspaceSwitcher)
      ? {
          value: '/workspaces',
          label: 'Workspaces',
          ariaLabel: 'Switch workspace',
          icon: <SwapHorizRoundedIcon />,
          iconOnly: true
        }
      : null,
    [canUseWorkspaceChooser, showsWorkspaceSwitcher]
  )
  // Settings is pinned at the end of the content tabs; the rest (core content +
  // plugin tabs) are user-orderable. Empty order → built-in default (Filament
  // after Printers). Device override wins over the workspace default.
  const sharedNavTabOrder = useMemo(() => generalSettingsQuery.data?.navTabOrder ?? [], [generalSettingsQuery.data?.navTabOrder])
  const effectiveNavTabOrder = deviceNavTabOrderOverride ?? sharedNavTabOrder
  const settingsTab = useMemo(() => coreTabs.find((tab) => tab.value === '/settings') ?? null, [coreTabs])
  // Core content tabs resolve on auth bootstrap but plugin tabs (Queue, Orders,
  // Filament) only after the plugin catalog query settles — a later, separate
  // round-trip. Rendering as each source arrives makes tabs visibly pop into the
  // bar one wave after another (worst on a workspace switch, which clears the
  // catalog first). Hold the whole content-tab set until the catalog has settled
  // (resolved, errored, or not applicable) so they appear together in one shot.
  const contentTabsReady = authBootstrapReady
    && (!pluginCatalogEnabled || hasPluginState || pluginStateQuery.isError)
  const navContentTabs = useMemo<ReadonlyArray<ShellTab>>(
    () => contentTabsReady
      ? orderNavTabs([...coreTabs.filter((tab) => tab.value !== '/settings'), ...pluginTabs], effectiveNavTabOrder)
      : [],
    [contentTabsReady, coreTabs, pluginTabs, effectiveNavTabOrder]
  )
  const tabs = useMemo<ReadonlyArray<ShellTab>>(
    () => [
      ...platformTabs,
      ...navContentTabs,
      ...(settingsTab ? [settingsTab] : []),
      ...(accountTab ? [accountTab] : []),
      ...(workspaceChooserTab ? [workspaceChooserTab] : [])
    ],
    [accountTab, navContentTabs, platformTabs, settingsTab, workspaceChooserTab]
  )

  const openPlatformWorkspace = (routePath: string) => {
    setPendingWorkspaceRoute({ routePath, targetTenantId: null, sourcePathname: appPathname })
    selectTenantContext.mutate({ tenantId: null, routePath })
  }

  const openTenantWorkspace = (tenantId: string, routePath: string) => {
    const tenantSlug = tenantSlugById.get(tenantId)
    if (!tenantSlug) return

    setPendingWorkspaceRoute({ routePath, targetTenantId: tenantId, sourcePathname: appPathname })
    if (isPlatformUser) {
      selectTenantContext.mutate({ tenantId, tenantSlug, routePath })
      return
    }

    switchTenant.mutate({ tenantId, tenantSlug, routePath })
  }

  const openWorkspaceChooser = () => {
    navigate(buildWorkspaceSelectionPath())
  }

  // Land a connect-bridge deep link on the chosen workspace's Bridges page with
  // the code stashed for pre-fill. The connect API is bound to the active tenant
  // context, so a non-active workspace is switched into first (the switch
  // mutation then navigates straight to the Bridges page via its routePath).
  const connectBridgeToWorkspace = (tenantId: string) => {
    if (!connectBridgeCode) return
    const tenantSlug = tenantId === activeTenantId
      ? (activeTenantSlug ?? tenantSlugById.get(tenantId))
      : tenantSlugById.get(tenantId)
    if (!tenantSlug) return
    stashPendingBridgeConnectCode(connectBridgeCode)
    const bridgesRoutePath = '/settings/bridges'
    if (tenantId === activeTenantId) {
      navigate(buildTenantWorkspacePath(tenantSlug, bridgesRoutePath))
      return
    }
    if (isPlatformUser) {
      selectTenantContext.mutate({ tenantId, tenantSlug, routePath: bridgesRoutePath })
      return
    }
    switchTenant.mutate({ tenantId, tenantSlug, routePath: bridgesRoutePath })
  }

  const renderTenantContextElement = (element: ReactNode) => {
    if (!authBootstrapReady) {
      return <Typography>Loading…</Typography>
    }

    if (authRouteState === 'auth') {
      return <AuthView redirectPath={currentRoute} />
    }

    if (tenantRouteRedirect == null) {
      return hasTenantContext ? renderProtectedElement(element) : <Typography>Loading…</Typography>
    }

    return <Navigate to={tenantRouteRedirect} replace />
  }

  const renderProtectedElement = (element: ReactNode) => {
    const protectedRouteState = resolveProtectedRouteState({
      authBootstrapReady,
      authEnabled,
      authSetupRequired,
      authProviderSetupAvailable,
      allowSetup: !hasTenantContext,
      isAuthenticated
    })

    if (protectedRouteState === 'loading') {
      return <Typography>Loading…</Typography>
    }
    if (protectedRouteState === 'auth') {
      return <AuthView redirectPath={currentRoute} />
    }

    return element
  }

  const renderAccountElement = () => {
    if (!authBootstrapReady) {
      return <Typography>Loading…</Typography>
    }

    return showsAccountTab
      ? renderProtectedElement(<AccountView />)
      : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
  }

  useEffect(() => {
    completeSplashScreen()
  }, [])

  const sharedUnconstrainedWidth = generalSettingsQuery.data?.unconstrainedWidth ?? false
  const sharedAppTheme = generalSettingsQuery.data?.appTheme ?? 'default'
  const effectiveUnconstrainedWidth = deviceUnconstrainedWidthOverride ?? sharedUnconstrainedWidth
  const effectiveAppTheme = deviceAppThemeOverride ?? sharedAppTheme
  const activeTab = tabs
    .filter((tab) => appPathname.startsWith(tab.value))
    .sort((left, right) => right.value.length - left.value.length)[0]?.value ?? defaultTab
  const usesPlatformTheme = shouldUsePlatformAuthTheme({
    hasTenantContext,
    canUsePlatformWorkspace,
    authRouteState
  })
  const workspaceChrome = effectiveAppTheme === 'aurora'
    ? (usesPlatformTheme ? platformAuroraChrome : auroraChrome)
    : (usesPlatformTheme ? platformChrome : defaultChrome)
  const workspaceChromeVars = useMemo(
    () => buildChromeCssVars(workspaceChrome),
    [workspaceChrome]
  )
  const workspaceTheme = effectiveAppTheme === 'aurora'
    ? (usesPlatformTheme ? platformAuroraTheme : auroraTheme)
    : (usesPlatformTheme ? platformTheme : theme)
  const usesPublicChrome = isWorkspaceSelectionRoute || isConnectBridgeRoute || isMarketingRoute || isPublicInfoRoute
  const shellTabs = usesPublicChrome ? [] : tabs
  const shellWorkspaceLabel = usesPublicChrome ? undefined : (inPlatformMode ? 'Platform' : undefined)
  const shellWorkspaceChooserLabel = usesPublicChrome ? undefined : currentWorkspaceChooserLabel
  const shellWorkspaceChooserAvailable = !usesPublicChrome && canUseWorkspaceChooser
  const devRuntimeIndicator = browserEnv.devMode ? (
    <DevRuntimeStatus
      webStartedAt={webRuntimeStartedAt}
      apiRuntime={devHealthQuery.data?.runtime ?? null}
      apiRuntimeLoading={devHealthQuery.isLoading}
      apiRuntimeError={devHealthQuery.isError}
    />
  ) : null
  // App-shell footer: the feedback entry point (plus any plugin-contributed
  // footer actions, e.g. the cloud suggestion box), dev runtime chips (dev
  // only), and the running build / update hint. AppVersionFooter renders
  // nothing when there is no build to show.
  const appFooterTrailing = (
    <Stack spacing={0.75} alignItems="center" useFlexGap>
      <Stack direction="row" spacing={1} useFlexGap alignItems="center" justifyContent="center" sx={{ flexWrap: 'wrap' }}>
        {/* Platform users staff the support inbox — hide the help entry point there. */}
        {!inPlatformMode && <HelpFeedbackButton />}
        <PluginSlot name="shell.footer" />
      </Stack>
      {devRuntimeIndicator}
      <AppVersionFooter />
    </Stack>
  )
  const shouldAutoSelectOnlyTenantWorkspace = authBootstrapReady
    && isAuthenticated
    && !isMarketingRoute
    && !isPublicInfoRoute
    && !hasTenantContext
    && !canUsePlatformWorkspace
    && memberTenantOptions.length === 1
  const tenantStatsRouteElement = renderTenantContextElement(
    <TenantStatsView />
  )
  const tenantGetStartedRouteElement = renderTenantContextElement(
    generalSettingsQuery.data == null
      ? <Typography>Loading…</Typography>
      : quickStartDismissed
        ? <Navigate to={defaultRoute} replace />
        : (
            <GetStartedView
              canOpenSettings={canOpenTenantSettings}
              canManageSettings={canManageSettings}
            />
          )
  )
  const tenantSettingsPath = activeTenantSlug ? buildTenantWorkspacePath(activeTenantSlug, '/settings') : buildWorkspaceSelectionPath()
  const accountPath = inPlatformMode
    ? '/platform/account'
    : activeTenantSlug
      ? buildTenantWorkspacePath(activeTenantSlug, '/account')
      : buildWorkspaceSelectionPath()
  const platformOverviewRouteElement = renderProtectedElement(
    canUsePlatformWorkspace
      ? (inPlatformMode
          ? platformAdmin
            ? <platformAdmin.OverviewView />
            : <Navigate to="/platform/settings" replace />
          : pendingWorkspaceRoute != null && pendingWorkspaceRoute.targetTenantId == null
            ? <Typography>Opening workspace…</Typography>
            : <Navigate to={buildWorkspaceSelectionPath()} replace />)
      : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
  )
  const publicRouteContext = {
    isAuthenticated,
    appHref: defaultRoute,
    // Billing/upgrade CTAs land on the account page (its Billing section), not
    // the workspace landing; without an active tenant fall back to the app entry.
    accountHref: activeTenantSlug ? buildTenantWorkspacePath(activeTenantSlug, '/account') : defaultRoute,
    demoLandingRoute: publicDemoLandingRoute
  }
  const marketingRootRoute = marketingRoutes.find((route) => route.path === '/')
  // Without a marketing module, `/` routes straight into the app.
  const rootRouteElement = marketingRootRoute
    ? marketingRootRoute.render(publicRouteContext)
    : tenantLandingRouteReady
      ? <Navigate to={defaultRoute} replace />
      : <Typography>Loading…</Typography>

  useEffect(() => {
    if (typeof document === 'undefined') return
    for (const [key, value] of Object.entries(workspaceChromeVars)) {
      document.documentElement.style.setProperty(key, value)
    }
  }, [workspaceChromeVars])

  useEffect(() => {
    if (!shouldAutoSelectOnlyTenantWorkspace) {
      return
    }
    if (appPathname !== tenantWorkspaceEntryRoute) {
      return
    }
    if (workspaceSwitchPending || pendingWorkspaceRoute) {
      return
    }

    const onlyTenantOption = memberTenantOptions[0]
    if (!onlyTenantOption) {
      return
    }

    const onlyTenantSlug = tenantSlugById.get(onlyTenantOption.id)
    if (!onlyTenantSlug) {
      return
    }

    setPendingWorkspaceRoute({
      routePath: tenantWorkspaceEntryRoute,
      targetTenantId: onlyTenantOption.id,
      sourcePathname: appPathname
    })
    switchTenant.mutate({
      tenantId: onlyTenantOption.id,
      tenantSlug: onlyTenantSlug,
      routePath: tenantWorkspaceEntryRoute
    })
  }, [
    appPathname,
    memberTenantOptions,
    pendingWorkspaceRoute,
    shouldAutoSelectOnlyTenantWorkspace,
    switchTenant,
    tenantWorkspaceEntryRoute,
    tenantSlugById,
    workspaceSwitchPending
  ])

  useEffect(() => {
    if (!pendingWorkspaceRoute) {
      return
    }
    if (!authBootstrapReady) {
      return
    }
    if (pendingWorkspaceRoute.targetTenantId == null) {
      if (hasTenantContext) {
        return
      }
    } else if (activeTenantId !== pendingWorkspaceRoute.targetTenantId) {
      return
    }

    const resolvedDestination = resolveWorkspaceSwitchDestination({
      currentPath: pendingWorkspaceRoute.routePath,
      defaultPath: defaultTab,
      inPlatformMode,
      canUsePlatformWorkspace,
      hasTenantContext,
      canViewPrinters,
      canViewLibrary,
      canViewJobs,
      canOpenSettings: canOpenTenantSettings,
      canViewAccount: showsAccountTab,
      enabledPluginBasePaths,
      pluginStateReady: pluginStateQuery.data?.plugins != null
    })

    if (resolvedDestination == null) {
      return
    }

    const nextRoute = pendingWorkspaceRoute.targetTenantId != null && activeTenantSlug && isTenantWorkspaceCandidatePath(resolvedDestination)
      ? buildTenantWorkspacePath(activeTenantSlug, resolvedDestination)
      : resolvedDestination

    if (nextRoute !== currentRoute) {
      navigate(nextRoute, { replace: true })
      return
    }

    setPendingWorkspaceRoute(null)
  }, [
    pendingWorkspaceRoute,
    authBootstrapReady,
    defaultTab,
    inPlatformMode,
    canUsePlatformWorkspace,
    hasTenantContext,
    activeTenantId,
    activeTenantSlug,
    canViewPrinters,
    canViewLibrary,
    canViewJobs,
    canOpenTenantSettings,
    showsAccountTab,
    enabledPluginBasePaths,
    pluginStateQuery.data?.plugins,
    currentRoute,
    navigate
  ])

  useEffect(() => {
    if (!pendingWorkspaceRoute) {
      return
    }
    if (!shouldClearPendingWorkspaceRoute({
      sourcePath: pendingWorkspaceRoute.sourcePathname,
      currentPath: appPathname,
      targetPath: pendingWorkspaceRoute.routePath
    })) {
      return
    }

    setPendingWorkspaceRoute(null)
  }, [appPathname, pendingWorkspaceRoute])

  return (
    <runtimePolicyContext.Provider value={runtimePolicy}>
      <CssVarsProvider theme={workspaceTheme} defaultMode="dark">
        <CssBaseline />
        <Box sx={workspaceChromeVars}>
          {authRouteState === 'auth' && !isPrivatePublicRoute ? (
            <AuthView redirectPath={currentRoute} />
          ) : (
            <AppShell
              tabs={shellTabs}
              activeTab={activeTab}
              currentPath={appPathname}
              onTabChange={(value) => {
                if (value === '/workspaces') {
                  openWorkspaceChooser()
                  return
                }
                if (activeTenantSlug && isTenantWorkspaceCandidatePath(value)) {
                  navigate(buildTenantWorkspacePath(activeTenantSlug, value))
                  return
                }
                navigate(value)
              }}
              onOpenAccount={showsAccountTab ? () => navigate(accountPath) : undefined}
              workspaceLabel={shellWorkspaceLabel}
              workspaceChooserLabel={shellWorkspaceChooserLabel}
              showNavigationFrame={false}
              unconstrainedWidth={effectiveUnconstrainedWidth}
              identity={isMarketingRoute || isPublicInfoRoute ? null : shellIdentity}
              workspaceChooserAvailable={shellWorkspaceChooserAvailable}
              onOpenWorkspaceChooser={openWorkspaceChooser}
              workspaceChooserPending={workspaceSwitchPending}
              onLogoClick={() => navigate('/')}
              footerTrailing={(isMarketingRoute || isPublicInfoRoute)
                ? (marketing ? <marketing.Footer /> : devRuntimeIndicator)
                : appFooterTrailing}
            >
              {disabledActivePluginRoute ? <Navigate to={inPlatformMode ? '/platform/settings/plugins' : `${tenantSettingsPath}/plugins`} replace /> : null}
              <AuthBootstrapQueryProvider value={authBootstrapQuery}>
                <PluginCatalogQueryProvider value={pluginStateQuery}>
                  <PrintDispatchJobsQueryProvider value={shellDispatchQuery}>
                    <ScrollReset />
                    {/* Headless plugin components that sync app-level state (e.g. unread badges). */}
                    <PluginSlot name="shell.background" />
                    {hasTenantContext && <LicenseBanner />}
                    {hasTenantContext && canManageSettings && <BridgeUpdateBanner />}
                    {hasTenantContext && canManageSettings && <BridgeCrashBanner />}
                    {hasTenantContext && canManageSettings && <BridgeDebugCaptureBanner />}
                    {hasTenantContext && <LibraryUploadPanel />}
                    <RouteErrorBoundary resetKey={location.pathname}>
                      <Routes>
                <Route path="/" element={rootRouteElement} />
                {marketingRoutes
                  .filter((route) => route.path !== '/')
                  .map((route) => (
                    <Route key={`marketing:${route.path}`} path={route.path} element={route.render(publicRouteContext)} />
                  ))}
                <Route
                  path="/auth"
                  element={
                    authRouteState === 'loading'
                      ? <Typography>Loading…</Typography>
                      : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                  }
                />
                <Route
                  path="/connect-bridge"
                  element={renderProtectedElement(
                    <ConnectBridgeView
                      code={connectBridgeCode}
                      workspaces={switchableTenantOptions}
                      activeTenantId={activeTenantId}
                      pending={workspaceSwitchPending}
                      onConnect={connectBridgeToWorkspace}
                    />
                  )}
                />
                <Route
                  path="/workspaces"
                  element={renderProtectedElement(
                    canUseWorkspaceChooser
                      ? (
                          <WorkspaceSelectionView
                            tenantOptions={switchableTenantOptions}
                            allowPlatformSelection={canUsePlatformWorkspace}
                            onPlatformSelect={canUsePlatformWorkspace ? () => openPlatformWorkspace(platformWorkspaceLandingRoute) : undefined}
                            onTenantSelect={(tenantId) => openTenantWorkspace(tenantId, tenantWorkspaceEntryRoute)}
                            selectionPending={workspaceSwitchPending}
                          />
                        )
                      : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                  )}
                />
                <Route
                  path="/workspaces/:tenantSlug"
                  element={tenantLandingRouteReady ? <Navigate to={tenantWorkspaceLandingRoute.slice(1)} replace /> : <Typography>Loading…</Typography>}
                />
                <Route
                  path="/platform"
                  element={platformOverviewRouteElement}
                />
                <Route
                  path="/platform/settings/*"
                  element={renderProtectedElement(
                    canUsePlatformWorkspace
                      ? (inPlatformMode ? <PlatformView /> : <Navigate to={tenantSettingsPath} replace />)
                      : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                  )}
                />
                {platformAdmin ? (
                  <Route
                    path="/platform/tenants"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace
                        ? (
                            inPlatformMode
                              ? (
                                  <platformAdmin.TenantsView
                                    canDisableTenants={canDisableTenants}
                                    canManageTenants={canManageTenants}
                                    accessibleTenantIds={tenantDirectoryAccessibleTenantIds}
                                    onOpenWorkspace={(tenantId) => {
                                      openTenantWorkspace(tenantId, tenantWorkspaceEntryRoute)
                                    }}
                                  />
                                )
                              : pendingWorkspaceRoute?.targetTenantId != null
                                ? <Typography>Opening workspace…</Typography>
                                : <Navigate to={tenantSettingsPath} replace />
                          )
                        : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                {platformAdmin ? (
                  <Route
                    path="/platform/billing"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace && inPlatformMode
                        ? <platformAdmin.BillingView />
                        : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                {platformAdmin ? (
                  <Route
                    path="/platform/messages"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace && inPlatformMode
                        ? <platformAdmin.MessagesView />
                        : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                {platformAdmin ? (
                  <Route
                    path="/platform/suggestions/*"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace && inPlatformMode
                        ? <platformAdmin.SuggestionsView />
                        : tenantLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                <Route path="/workspaces/:tenantSlug/printers" element={renderTenantContextElement(<PrintersView />)} />
                <Route path="/workspaces/:tenantSlug/printers/:printerId" element={renderTenantContextElement(<PrintersView />)} />
                <Route path="/workspaces/:tenantSlug/library" element={renderTenantContextElement(<LibraryView />)} />
                {/* Static `favorites` outranks the `:folderId` route below, giving the favorites view its own bookmarkable URL. */}
                <Route path="/workspaces/:tenantSlug/library/favorites" element={renderTenantContextElement(<LibraryView />)} />
                <Route path="/workspaces/:tenantSlug/library/:folderId" element={renderTenantContextElement(<LibraryView />)} />
                <Route path="/workspaces/:tenantSlug/get-started" element={tenantGetStartedRouteElement} />
                <Route path="/workspaces/:tenantSlug/stats" element={tenantStatsRouteElement} />
                <Route path="/workspaces/:tenantSlug/jobs" element={renderTenantContextElement(<JobsView />)} />
                <Route
                  path="/workspaces/:tenantSlug/account"
                  element={renderTenantContextElement(renderAccountElement())}
                />
                <Route
                  path="/platform/account"
                  element={renderAccountElement()}
                />
                <Route
                  path="/workspaces/:tenantSlug/settings/*"
                  element={inPlatformMode
                    ? <Navigate to="/platform/settings" replace />
                    : renderTenantContextElement(
                        (canManageSettings || canManageTenants || (canOpenTenantAuthSettings && isTenantAuthSettingsRoute) || (canOpenTenantAuthSettings && appPathname === '/settings')) ? (
                          canOpenTenantAuthSettings && !canManageSettings && !canManageTenants && appPathname === '/settings'
                            ? <Navigate to={buildTenantWorkspacePath(routeTenantSlug ?? activeTenantSlug ?? PUBLIC_DEMO_TENANT_SLUG, '/settings/authentication')} replace />
                            : (
                          <SettingsView
                            sharedAppTheme={sharedAppTheme}
                            sharedUnconstrainedWidth={sharedUnconstrainedWidth}
                            sharedLandingPage={sharedLandingPage}
                            landingPageOptions={landingPageOptions}
                            deviceAppThemeOverride={deviceAppThemeOverride}
                            deviceUnconstrainedWidthOverride={deviceUnconstrainedWidthOverride}
                            deviceLandingPageOverride={deviceLandingPageOverride}
                            sharedSettingsError={generalSettingsQuery.error ? extractErrorMessage(generalSettingsQuery.error) : null}
                            sharedSettingsSaving={updateGeneralSettings.isPending}
                            sharedSettingsSaveError={updateGeneralSettings.error ? extractErrorMessage(updateGeneralSettings.error) : null}
                            onSetDeviceAppTheme={setDeviceAppThemeOverride}
                            onClearDeviceAppThemeOverride={() => setDeviceAppThemeOverride(null)}
                            onSetDeviceUnconstrainedWidth={setDeviceUnconstrainedWidthOverride}
                            onClearDeviceUnconstrainedWidthOverride={() => setDeviceUnconstrainedWidthOverride(null)}
                            onSetDeviceLandingPage={setDeviceLandingPageOverride}
                            onClearDeviceLandingPageOverride={() => setDeviceLandingPageOverride(null)}
                            onSetSharedAppTheme={(appTheme) => updateGeneralSettings.mutate({ appTheme })}
                            onSetSharedUnconstrainedWidth={(unconstrainedWidth) => updateGeneralSettings.mutate({ unconstrainedWidth })}
                            onSetSharedLandingPage={(landingPage) => updateGeneralSettings.mutate({ landingPage })}
                            navTabOptions={navContentTabs.map((tab) => ({ value: tab.value, label: tab.label }))}
                            sharedNavTabOrder={sharedNavTabOrder}
                            deviceNavTabOrder={deviceNavTabOrderOverride}
                            onSetSharedNavTabOrder={(navTabOrder) => updateGeneralSettings.mutate({ navTabOrder })}
                            onSetDeviceNavTabOrder={setDeviceNavTabOrderOverride}
                            onClearDeviceNavTabOrderOverride={() => setDeviceNavTabOrderOverride(null)}
                          />
                            )
                        ) : (
                          <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>Settings access required.</Alert>
                        )
                      )}
                />
                {pluginRoutes.map((route) => {
                  const Element = route.element
                  return <Route key={`${route.pluginName}:scoped:${route.path}`} path={tenantScopedRoutePath(route.path)} element={renderTenantContextElement(<Element />)} />
                })}
                {/* A known plugin route (e.g. /queue) on a cold load isn't mounted yet while the plugin
                    catalog resolves — wait rather than redirect home. See catchAllRouteDecision. */}
                <Route
                  path="*"
                  element={catchAllDecision === 'wait'
                    ? <Typography>Loading…</Typography>
                    : catchAllDecision === 'defer-to-plugin-handling'
                      ? null
                      : <Navigate to="/" replace />}
                />
                      </Routes>
                    </RouteErrorBoundary>
                    <StatusToastStack>
                      {(authBootstrapReady && hasTenantContext && isAuthenticated && canViewJobs) && <DispatchToasts />}
                      {(authBootstrapReady && hasTenantContext && isAuthenticated && canUploadLibrary) && <SlicingToasts />}
                      {(authBootstrapReady && hasTenantContext && isAuthenticated && (canManageLibrary || canManagePrinters)) && <DeleteOperationToasts />}
                      <Toaster />
                    </StatusToastStack>
                  </PrintDispatchJobsQueryProvider>
                </PluginCatalogQueryProvider>
              </AuthBootstrapQueryProvider>
            </AppShell>
          )}
        </Box>
      </CssVarsProvider>
    </runtimePolicyContext.Provider>
  )
}

interface RouteErrorBoundaryState {
  error: Error | null
}

class RouteErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Route render failed', error, errorInfo)
    toast.error(extractErrorMessage(error, 'This screen crashed while rendering'))
  }

  override componentDidUpdate(previousProps: { resetKey: string }) {
    // Clear the caught error when the route changes, so navigating away from a
    // crashed screen recovers instead of leaving the error UI stuck in place.
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private reset = () => {
    this.setState({ error: null })
  }

  override render() {
    if (!this.state.error) return this.props.children

    const message = extractErrorMessage(this.state.error, 'This screen crashed while rendering')

    return (
      <Box sx={{ py: 2 }}>
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
          <Stack spacing={1.25} sx={{ alignItems: 'flex-start' }}>
            <Typography level="title-md">Something went wrong</Typography>
            <Typography level="body-sm">
              {message}
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              The current screen failed to render. You can retry, go back to the printers page, or reload the app.
            </Typography>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
              <Button size="sm" variant="solid" color="danger" onClick={this.reset}>Try again</Button>
              <Button size="sm" variant="soft" color="neutral" onClick={() => window.location.assign('/workspaces')}>Choose workspace</Button>
              <Button size="sm" variant="plain" color="neutral" onClick={() => window.location.reload()}>Reload</Button>
            </Stack>
          </Stack>
        </Alert>
      </Box>
    )
  }
}

function ScrollReset() {
  const { pathname } = useLocation()
  const previousPathnameRef = useRef(pathname)

  useEffect(() => {
    if (previousPathnameRef.current === pathname) return

    previousPathnameRef.current = pathname
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [pathname])

  return null
}

