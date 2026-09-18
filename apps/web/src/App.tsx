import { Alert, Box, Button, Stack, Typography } from '@mui/joy'
import CssBaseline from '@mui/joy/CssBaseline'
import { NativeBillingButton } from './native/NativeBillingButton'
import { AppThemeProvider } from './theme/AppThemeProvider'
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
  WORKSPACES_DISABLE_PERMISSION,
  WORKSPACES_MANAGE_PERMISSION,
  PUBLIC_DEMO_WORKSPACE_SLUG,
  DEFAULT_APP_LANDING_PAGE,
  extractErrorMessage,
  type AppLandingPageSetting,
  type AppThemeSetting,
  type CustomerSummary,
  type GeneralSettings,
  type Permission,
  type UpdateGeneralSettingsInput
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { isNativeConnectionReady } from './native/connectionReady'
import { useNativeSession } from './native/useNativeSession'
import { isNativeApp, PrintStreamInstance } from './native/bridge'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppShell, type ShellTab } from './components/AppShell'
import { ScrollReset } from './components/ScrollReset'
import {
  DEVICE_APP_THEME_OVERRIDE_KEY,
  DEVICE_BILLING_APP_THEME_OVERRIDE_KEY,
  DEVICE_PLATFORM_APP_THEME_OVERRIDE_KEY,
  BOOT_BACKGROUND_CACHE_KEY,
  DEVICE_LANDING_PAGE_OVERRIDE_KEY_PREFIX,
  DEVICE_NAV_TAB_ORDER_OVERRIDE_KEY_PREFIX,
  DEVICE_UNCONSTRAINED_WIDTH_OVERRIDE_KEY,
  catchAllRouteDecision,
  parseNullableAppLandingPageSetting,
  parseNullableAppThemeSetting,
  parseNullableBoolean,
  parseNullableNavTabOrder,
  resolveActiveNavTab,
  workspaceScopedRoutePath
} from './appShellHelpers'
import { orderNavTabs } from './lib/navTabOrder'
import { marketingModule, platformAdminModule, PrivateBillingEntryView } from './lib/privateModules'
import { BridgeUpdateBanner } from './components/BridgeUpdateBanner'
import { LicenseBanner } from './components/LicenseBanner'
import { BridgeCrashBanner } from './components/BridgeCrashBanner'
import { BridgeDebugCaptureBanner } from './components/BridgeDebugCaptureBanner'
import { LibraryUploadPanel } from './components/LibraryUploadPanel'
import { AppVersionFooter } from './components/AppVersionFooter'
import { BILLING_SCOPE_SECTION_ICONS } from './components/billingScopeSectionIcons'
import { HelpFeedbackButton } from './components/HelpFeedbackButton'
import { PluginSlot } from './plugin/PluginSlot'
import { StaticPluginSlot } from './plugin/StaticPluginSlot'
import { DeleteOperationToasts } from './components/DeleteOperationToasts'
import { DispatchToasts } from './components/DispatchToasts'
import { EngineInstallToast } from './components/EngineInstallToast'
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
import { isWorkspaceLandingReady, pluginBasePath, resolveDefaultWorkspaceRoute, resolveWorkspaceRouteRedirect, resolveWorkspaceLandingPath, resolveWorkspaceSwitchDestination, shouldClearPendingWorkspaceRoute } from './lib/workspaceSwitch'
import {
  WORKSPACE_CHOOSER_LABEL, buildPlatformWorkspacePath, buildWorkspacePath, buildWorkspaceSelectionPath, isPlatformWorkspacePath, isWorkspaceCandidatePath, parseWorkspacePathname } from './lib/workspaceRoute'
import {
  activePluginSlots,
  isPluginActiveByName,
  shouldMountPluginRouteByName,
  pluginSupportsDeployment,
  pluginSupportsRuntimeSurface
} from './lib/pluginSettings'
import { runtimePolicyContext } from './lib/runtimePolicy'
import { completeSplashScreen } from './lib/splashScreen'
import { toast } from './lib/toast'
import { resolveShellIdentity } from './lib/authUi'
import { countAccessibleWorkspaceChoices, countSwitchableWorkspaceChoices, listAccessibleWorkspaces } from './lib/workspaceAccess'
import { readWorkspaceContextHint } from './lib/workspaceContext'
import { JobsView } from './pages/JobsView'
import { LibraryView } from './pages/LibraryView'
import { PrintersView } from './pages/PrintersView'
import { AccountView } from './pages/AccountView'
import { AuthView } from './pages/AuthView'
import { PlatformView } from './pages/PlatformView'
import { SettingsView } from './pages/SettingsView'
import { GetStartedView } from './pages/GetStartedView'
import { WorkspaceStatsView } from './pages/WorkspaceStatsView'
import { WorkspaceSelectionView } from './pages/WorkspaceSelectionView'
import { ConnectBridgeView } from './pages/ConnectBridgeView'
import { stashPendingBridgeConnectCode } from './lib/pendingBridgeConnect'
import { CORE_LANDING_PAGE_OPTIONS } from './lib/landingPageOptions'
import { AccountSlotView } from './pages/AccountSlotView'
import {
  accountSlotHasContent,
  ACCOUNT_MESSAGES_SLOT
} from './lib/accountSlots'
import {
  BILLING_SCOPE_LABEL,
  BILLING_SCOPE_ROUTE,
  billingScopeSections,
  BILLING_SCOPE_SECTION_ROUTE,
  BILLING_SCOPE_SLOT,
  buildBillingScopePath,
  parseBillingScopePath
} from './lib/billingScope'
import { BillingScopeView } from './pages/BillingScopeView'
import { webPluginRegistry } from './plugin/registry'
import { registerBuiltinPlugins } from './plugin/builtin'
import { buildChromeCssVars } from './theme/buildTheme'
import { auroraChrome, auroraTheme, defaultChrome, theme } from './theme/theme'
import { flatThemeVariants, isFlatAppTheme } from './theme/flatThemes'
import { platformAuroraChrome, platformAuroraTheme, platformChrome, platformFlatThemeVariants, platformTheme } from './theme/platformTheme'
import { customerApiBase } from './lib/customerRoutes'

// Descriptions say what the page is FOR. A tooltip only appears on a tab whose
// label is already readable, so one that restates the label would be pure noise
// -- each of these has to tell you something the single word cannot.
const baseCoreTabs: ReadonlyArray<ShellTab> = [
  {
    value: '/get-started',
    label: 'Get started',
    description: 'The steps left before this workspace can print.',
    mobileIcon: <ChecklistRoundedIcon />
  },
  {
    value: '/printers',
    label: 'Printers',
    description: 'Live status for every printer, and where you add or control one.',
    mobileIcon: <Printer3dRoundedIcon />
  },
  {
    value: '/library',
    label: 'Library',
    description: 'Your models and sliced files, ready to send to a printer.',
    mobileIcon: <FolderCopyRoundedIcon />
  },
  {
    value: '/jobs',
    label: 'Jobs',
    description: 'What is printing now, and everything that has printed before.',
    mobileIcon: <HistoryRoundedIcon />
  },
  {
    value: '/stats',
    label: 'Stats',
    description: 'Print time, filament used, and success rates over time.',
    mobileIcon: <QueryStatsRoundedIcon />
  },
]

// Default left-to-right order for the leading plugin tabs (Orders, Filament,
// then Calibration: Calibration sits after Filament); any other plugin tab falls
// back to alphabetical after these. The final interleaving with core tabs is
// governed by DEFAULT_NAV_TAB_ORDER.
const PLUGIN_TAB_DEFAULT_ORDER: readonly string[] = ['/orders', '/filament', '/calibration']

// Register built-in plugins when this (lazy-loaded) app-shell chunk first loads: moved out of
// main.tsx so a cold load of a marketing page never pulls in the plugin graph. Runs once at module
// import, before <App> first renders (which reads webPluginRegistry.routes()).
registerBuiltinPlugins()

const NO_CUSTOMERS: CustomerSummary[] = []

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
  const routeWorkspaceSlug = workspacePath.workspaceSlug
  const appPathname = workspacePath.appPathname
  const routePlatformWorkspace = isPlatformWorkspacePath(location.pathname)
  const authBootstrapScopeKey = routeWorkspaceSlug ? `workspace:${routeWorkspaceSlug}` : routePlatformWorkspace ? 'platform' : 'ambient'
  const previousWorkspaceScopeKey = useRef(authBootstrapScopeKey)
  const [pendingWorkspaceRoute, setPendingWorkspaceRoute] = useState<{
    routePath: string
    targetWorkspaceId: string | null
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
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const authBootstrapReady = authBootstrapQuery.isSuccess
  const authSetupRequired = authBootstrapQuery.data?.setupRequired ?? false
  const hasWorkspaceContext = authBootstrapQuery.data?.workspace != null
  // Read from the registry, not from a build flag: the plugins are registered at
  // module load, so this is settled before the first render and is the same
  // answer the route and the nav tab need.
  // Billing scopes this user was explicitly granted. Empty for everyone until an
  // account owner grants access, and in a public build.
  // A stable fallback, not `?? []`: this feeds a `useMemo` dependency, and a
  // fresh array each render would re-run it on every render.
  const customerOptions = authBootstrapQuery.data?.customers ?? NO_CUSTOMERS
  const hasBillingScopeView = accountSlotHasContent(BILLING_SCOPE_SLOT)
  const actorType = authBootstrapQuery.data?.actor.type ?? 'anonymous'
  const isPlatformUser = authBootstrapQuery.data?.actor.type === 'user' && (authBootstrapQuery.data.actor.isPlatformUser ?? false)
  // Self-hosted (OSS) deployments hide the cloud-only platform-admin and
  // marketing surfaces even when their private modules are present (a developer
  // running the private tree with SELF_HOSTED=true). In a real public build the
  // modules are already absent, so these stay null regardless.
  const selfHostedDeployment = authBootstrapQuery.data?.runtimePolicy.selfHosted ?? false
  const nativeConnectionReady = isNativeConnectionReady({
    ready: authBootstrapReady,
    actorType,
    selfHosted: selfHostedDeployment,
    authEnabled,
    setupRequired: authSetupRequired,
    hasWorkspace: hasWorkspaceContext
  })
  useNativeSession(
    authBootstrapReady && !authBootstrapQuery.isFetching,
    nativeConnectionReady,
    selfHostedDeployment && actorType === 'user',
    authBootstrapQuery.data
  )
  const platformAdmin = selfHostedDeployment ? null : platformAdminModule
  const marketing = selfHostedDeployment ? null : marketingModule
  const canUsePlatformWorkspace = isPlatformUser
  const inPlatformMode = canUsePlatformWorkspace && !hasWorkspaceContext
  const isAuthenticated = actorType !== 'anonymous'
  const authProviderSetupAvailable = authBootstrapReady
    && !hasWorkspaceContext
    && !authEnabled
    && !isAuthenticated
    && (authBootstrapQuery.data?.providers.length ?? 0) > 0
  const grantedPermissions = authBootstrapQuery.data?.permissions ?? []
  const memberWorkspaceOptions = useMemo(
    () => listAccessibleWorkspaces(authBootstrapQuery.data?.memberWorkspaces ?? []),
    [authBootstrapQuery.data?.memberWorkspaces]
  )
  const availableWorkspaceOptions = useMemo(
    () => listAccessibleWorkspaces(authBootstrapQuery.data?.availableWorkspaces ?? []),
    [authBootstrapQuery.data?.availableWorkspaces]
  )
  const memberWorkspaceIds = useMemo(
    () => new Set(memberWorkspaceOptions.map((workspace) => workspace.id)),
    [memberWorkspaceOptions]
  )
  const switchableWorkspaceOptions = memberWorkspaceOptions
  const workspaceDirectoryAccessibleWorkspaceIds = useMemo(
    () => new Set(availableWorkspaceOptions.map((workspace) => workspace.id)),
    [availableWorkspaceOptions]
  )
  const workspaceChoiceCount = useMemo(
    () => countAccessibleWorkspaceChoices({
      workspaces: switchableWorkspaceOptions,
      includePlatform: canUsePlatformWorkspace
    }),
    [switchableWorkspaceOptions, canUsePlatformWorkspace]
  )
  const activeWorkspaceId = authBootstrapQuery.data?.workspace?.id ?? null
  const activeWorkspaceSlug = authBootstrapQuery.data?.workspace?.slug ?? null
  const switchableWorkspaceChoiceCount = useMemo(
    () => countSwitchableWorkspaceChoices({
      workspaces: switchableWorkspaceOptions,
      includePlatform: canUsePlatformWorkspace,
      activeWorkspaceId,
      // Only the ones the chooser will actually render: without the billing
      // view registered there is no card to click, and counting them would
      // offer a chooser with nothing in it.
      customerCount: hasBillingScopeView ? customerOptions.length : 0
    }),
    [activeWorkspaceId, switchableWorkspaceOptions, canUsePlatformWorkspace, customerOptions, hasBillingScopeView]
  )
  const workspaceSlugById = useMemo(
    () => new Map([...availableWorkspaceOptions, ...switchableWorkspaceOptions].map((workspace) => [workspace.id, workspace.slug] as const)),
    [availableWorkspaceOptions, switchableWorkspaceOptions]
  )
  const hasPermission = (permission: Permission) => grantedPermissions.includes(permission)
  const canViewAuth = hasPermission(AUTH_ACCESS_VIEW_PERMISSION)
  const canManageSettings = hasPermission(SETTINGS_MANAGE_PERMISSION)
  const canDisableWorkspaces = hasPermission(WORKSPACES_DISABLE_PERMISSION)
  const canManageWorkspaces = hasPermission(WORKSPACES_MANAGE_PERMISSION)
  const isWorkspaceAuthSettingsRoute = appPathname === '/settings/authentication' || appPathname.startsWith('/settings/auth/')
  const canOpenWorkspaceAuthSettings = hasWorkspaceContext && canViewAuth
  const canOpenWorkspaceSettings = canManageSettings || canManageWorkspaces || canOpenWorkspaceAuthSettings
  const canManageLibrary = hasPermission(LIBRARY_MANAGE_PERMISSION)
  const canUploadLibrary = hasPermission(LIBRARY_UPLOAD_PERMISSION)
  const canManagePrinters = hasPermission(PRINTERS_MANAGE_PERMISSION)
  usePrinterWebSocket(
    authBootstrapReady
      && (isAuthenticated || (hasWorkspaceContext && !authEnabled))
      && (routeWorkspaceSlug != null || routePlatformWorkspace),
    routeWorkspaceSlug ? `workspace:${routeWorkspaceSlug}` : 'platform'
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
  const [devicePlatformAppThemeOverride, setDevicePlatformAppThemeOverride] = useLocalStorageState<AppThemeSetting | null>(
    DEVICE_PLATFORM_APP_THEME_OVERRIDE_KEY,
    null,
    parseNullableAppThemeSetting
  )
  // Read-only here: the billing Settings panel owns the writes, and this hook
  // is notified of them because they share the key.
  const [deviceBillingAppThemeOverride] = useLocalStorageState<AppThemeSetting | null>(
    DEVICE_BILLING_APP_THEME_OVERRIDE_KEY,
    null,
    parseNullableAppThemeSetting
  )
  const deviceLandingPageOverrideKey = `${DEVICE_LANDING_PAGE_OVERRIDE_KEY_PREFIX}.${activeWorkspaceSlug ?? routeWorkspaceSlug ?? 'ambient'}`
  const [deviceLandingPageOverride, setDeviceLandingPageOverride, deviceLandingPageOverrideLoaded] = useLocalStorageState<AppLandingPageSetting | null>(
    deviceLandingPageOverrideKey,
    null,
    parseNullableAppLandingPageSetting
  )
  const deviceNavTabOrderOverrideKey = `${DEVICE_NAV_TAB_ORDER_OVERRIDE_KEY_PREFIX}.${activeWorkspaceSlug ?? routeWorkspaceSlug ?? 'ambient'}`
  const [deviceNavTabOrderOverride, setDeviceNavTabOrderOverride] = useLocalStorageState<string[] | null>(
    deviceNavTabOrderOverrideKey,
    null,
    parseNullableNavTabOrder
  )
  const pluginStateQuery = usePluginCatalogQuery({
    enabled: authBootstrapQuery.isSuccess ? (isAuthenticated || (hasWorkspaceContext && !authEnabled)) : false,
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
  const switchWorkspace = useMutation({
    mutationFn: ({ workspaceId }: { workspaceId: string; workspaceSlug: string; routePath: string }) => apiFetch<void>('/api/auth/switch-workspace', {
      method: 'POST',
      body: { workspaceId }
    }),
    onSuccess: async (_data, variables) => {
      const nextRoute = buildWorkspacePath(variables.workspaceSlug, variables.routePath)
      if (nextRoute !== currentRoute) {
        navigate(nextRoute, { replace: true })
      }
      await invalidateWorkspaceShellQueries()
    }
  })
  const selectWorkspaceContext = useMutation({
    mutationFn: ({ workspaceId }: { workspaceId: string | null; workspaceSlug?: string; routePath: string }) => apiFetch<void>('/api/auth/workspace-context', {
      method: 'POST',
      body: { workspaceId }
    }),
    onSuccess: async (_data, variables) => {
      if (variables.workspaceId == null) {
        if (variables.routePath !== currentRoute) {
          navigate(variables.routePath, { replace: true })
        }
        await invalidateWorkspaceShellQueries()
      } else if (variables.workspaceSlug) {
        const nextRoute = buildWorkspacePath(variables.workspaceSlug, variables.routePath)
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
  const currentPluginSurface = inPlatformMode ? 'platform' : 'workspace'
  const apiPluginsByName = useMemo(
    () => new Map((pluginStateQuery.data?.plugins ?? []).map((plugin) => [plugin.name, plugin] as const)),
    [pluginStateQuery.data?.plugins]
  )
  // `App` owns the runtime-policy provider, so it cannot consume that context
  // itself. Apply the same pure slot filters with the policy already resolved
  // from auth bootstrap instead of calling `usePluginSlots` above the provider.
  const hasMessagesSlot = useMemo(
    () => activePluginSlots(webPluginRegistry.slots(ACCOUNT_MESSAGES_SLOT), {
      selfHosted: selfHostedDeployment,
      actorType: authBootstrapQuery.data?.actor.type,
      currentSurface: currentPluginSurface,
      apiPluginsByName,
      hasPluginState: pluginStateQuery.data?.plugins != null
    }).length > 0,
    [
      apiPluginsByName,
      authBootstrapQuery.data?.actor.type,
      currentPluginSurface,
      pluginStateQuery.data?.plugins,
      selfHostedDeployment
    ]
  )
  const pluginRoutes = useMemo(
    () => allPluginRoutes
      .filter((route) => pluginSupportsDeployment(route, selfHostedDeployment))
      .filter((route) => pluginSupportsRuntimeSurface(route, currentPluginSurface))
      .filter((route) => isPluginActiveByName(route.pluginName, apiPluginsByName, pluginStateQuery.data?.plugins != null)),
    [allPluginRoutes, apiPluginsByName, currentPluginSurface, pluginStateQuery.data?.plugins, selfHostedDeployment]
  )
  // Routes, unlike tabs, stay mounted through the plugin-state load window so a
  // cold-loaded deep link is not 404'd before the catalog answers.
  const mountedPluginRoutes = useMemo(
    () => allPluginRoutes
      .filter((route) => pluginSupportsDeployment(route, selfHostedDeployment))
      .filter((route) => pluginSupportsRuntimeSurface(route, currentPluginSurface))
      .filter((route) => shouldMountPluginRouteByName(route.pluginName, apiPluginsByName, pluginStateQuery.data?.plugins != null)),
    [allPluginRoutes, apiPluginsByName, currentPluginSurface, pluginStateQuery.data?.plugins, selfHostedDeployment]
  )
  const pluginTabs = useMemo<ReadonlyArray<ShellTab>>(
    () => pluginRoutes
      .filter((route) => Boolean(route.navLabel))
      .map((route) => {
        const tabValue = pluginBasePath(route.path)
        const mobileIcon = route.navMobileIcon
          ?? (tabValue === '/orders' ? <ChecklistRoundedIcon /> : <ExtensionRoundedIcon />)
        return {
          value: tabValue,
          label: route.navLabel ?? tabValue,
          description: route.navDescription,
          mobileIcon
        }
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
    enabled: authBootstrapReady && hasWorkspaceContext && isAuthenticated && canViewJobs,
    idleRefetchInterval: 10_000,
    suppressGlobalErrorToast: true
  })
  const showsAccountTab = shouldShowAccountTab({
    authBootstrapReady,
    actorType,
    activeWorkspaceId,
    memberWorkspaceIds
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
  // Plugin routes (e.g. /orders) are only mounted once the plugin catalog query resolves, which itself
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
  const pluginCatalogEnabled = authBootstrapReady && (isAuthenticated || (hasWorkspaceContext && !authEnabled))
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
        if (tab.value === '/get-started') return hasWorkspaceContext && !quickStartDismissed
        if (tab.value === '/printers') return hasWorkspaceContext && canViewPrinters
        if (tab.value === '/library') return hasWorkspaceContext && canViewLibrary
        if (tab.value === '/jobs') return hasWorkspaceContext && canViewJobs
        return true
      })
    },
    [authBootstrapReady, canViewJobs, canViewLibrary, canViewPrinters, hasWorkspaceContext, inPlatformMode, quickStartDismissed]
  )
  const platformTabs = useMemo<ReadonlyArray<ShellTab>>(
    () => inPlatformMode
      ? [...(platformAdmin?.navTabs ?? [])]
      : [],
    [inPlatformMode, platformAdmin]
  )
  const workspaceContextHint = readWorkspaceContextHint()
  const canUseWorkspaceChooser = authBootstrapReady && isAuthenticated && switchableWorkspaceChoiceCount > 0
  const requiresWorkspaceSelection = authBootstrapReady
    && isAuthenticated
    && !hasWorkspaceContext
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
  const workspaceLandingRoute = !quickStartDismissed
    ? '/get-started'
    : resolveWorkspaceLandingPath({
        preferredPage: effectiveLandingPage,
        canViewPrinters,
        canViewLibrary,
        canViewJobs,
        canOpenSettings: canOpenWorkspaceSettings,
        enabledPluginBasePaths
      })
  const workspaceEntryRoute = '/'
  const defaultTab = requiresWorkspaceSelection ? buildWorkspaceSelectionPath() : inPlatformMode ? buildPlatformWorkspacePath() : workspaceLandingRoute
  const defaultRoute = resolveDefaultWorkspaceRoute({
    activeWorkspaceSlug,
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
  const currentWorkspaceChooserLabel = authBootstrapQuery.data?.workspace?.name ?? (inPlatformMode ? 'Platform' : undefined)
  const currentRoute = `${location.pathname}${location.search}${location.hash}`
  // Connect-bridge deep link (`/connect-bridge?code=…`): workspace-agnostic, so
  // the bridge can build it without knowing the workspace slug.
  const connectBridgeCode = appPathname === '/connect-bridge'
    ? new URLSearchParams(location.search).get('code')
    : null
  const workspacelessRedirect = buildWorkspaceSelectionPath()
  const workspaceSwitchPending = switchWorkspace.isPending || selectWorkspaceContext.isPending
  const platformWorkspaceLandingRoute = buildPlatformWorkspacePath()
  const publicDemoLandingRoute = buildWorkspacePath(PUBLIC_DEMO_WORKSPACE_SLUG, '/printers')
  const isWorkspaceSelectionRoute = routeWorkspaceSlug == null && appPathname === buildWorkspaceSelectionPath()
  // The connect-bridge deep link is a focused, workspace-agnostic landing: show
  // it with the same clean chrome as the workspace chooser (no tabs/workspace
  // label), not wrapped in the workspace or platform shell.
  const isConnectBridgeRoute = routeWorkspaceSlug == null && appPathname === '/connect-bridge'
  // Marketing/public routes come from the optional private marketing module.
  // Without it (public open-source builds) none of these flags fire and `/`
  // falls through to the in-app landing redirect.
  const marketingRoutes = marketing?.routes ?? []
  const isMarketingRoute = routeWorkspaceSlug == null
    && appPathname === '/'
    && marketingRoutes.some((route) => route.path === '/')
  const isPublicInfoRoute = routeWorkspaceSlug == null
    && marketingRoutes.some((route) => route.publicChrome && route.path !== '/' && route.path === appPathname)
  // Marketing-module routes must skip the top-level auth gate: a cached ambient
  // bootstrap reports global auth enabled, which would otherwise render the
  // sign-in wall synchronously before the route element can run.
  const isPrivatePublicRoute = routeWorkspaceSlug == null && marketingRoutes.some((route) => route.path === appPathname)
  const workspaceLandingRouteReady = isWorkspaceLandingReady({
    routeWorkspaceSlug,
    activeWorkspaceSlug,
    authBootstrapReady,
    sharedSettingsReady: generalSettingsQuery.data != null,
    deviceLandingPageOverrideLoaded
  })
  const authRouteState = resolveAuthRouteState({
    authBootstrapReady,
    authEnabled,
    authSetupRequired,
    authProviderSetupAvailable,
    allowSetup: !hasWorkspaceContext,
    isAuthenticated
  })
  const workspaceRouteRedirect = routeWorkspaceSlug != null
    && authBootstrapReady
    && authRouteState !== 'auth'
    && (activeWorkspaceSlug == null || activeWorkspaceSlug !== routeWorkspaceSlug)
    ? workspacelessRedirect
    : resolveWorkspaceRouteRedirect({
        authBootstrapReady,
        hasWorkspaceContext,
        workspacelessRedirect
      })
  const showsWorkspaceSwitcher = shouldShowWorkspaceSwitcher({
    authRouteState,
    canUseWorkspaceChooser,
    nativeApp: isNativeApp(),
    requestedWorkspaceSlug: routeWorkspaceSlug,
    activeWorkspaceSlug
  })
  const workspaceChooserTab = useMemo<ShellTab | null>(
    () => showsWorkspaceSwitcher
      ? {
          value: '/workspaces',
          label: 'Workspaces',
          ariaLabel: WORKSPACE_CHOOSER_LABEL,
          icon: <SwapHorizRoundedIcon />,
          iconOnly: true
        }
      : null,
    [showsWorkspaceSwitcher]
  )
  // Content tabs are user-orderable. Settings and Account live in the footer,
  // leaving the toolbar for the workspace's primary destinations. Empty order
  // uses the built-in default (Filament after Printers). Device override wins
  // over the workspace default.
  const sharedNavTabOrder = useMemo(() => generalSettingsQuery.data?.navTabOrder ?? [], [generalSettingsQuery.data?.navTabOrder])
  const effectiveNavTabOrder = deviceNavTabOrderOverride ?? sharedNavTabOrder
  // Core content tabs resolve on auth bootstrap but plugin tabs (Queue, Orders,
  // Filament) only after the plugin catalog query settles, a later, separate
  // round-trip. Rendering as each source arrives makes tabs visibly pop into the
  // bar one wave after another (worst on a workspace switch, which clears the
  // catalog first). Hold the whole content-tab set until the catalog has settled
  // (resolved, errored, or not applicable) so they appear together in one shot.
  const contentTabsReady = authBootstrapReady
    && (!pluginCatalogEnabled || hasPluginState || pluginStateQuery.isError)
  const navContentTabs = useMemo<ReadonlyArray<ShellTab>>(
    () => contentTabsReady
      ? orderNavTabs([...coreTabs, ...pluginTabs], effectiveNavTabOrder)
      : [],
    [contentTabsReady, coreTabs, pluginTabs, effectiveNavTabOrder]
  )
  const tabs = useMemo<ReadonlyArray<ShellTab>>(
    () => [
      ...platformTabs,
      ...navContentTabs,
      ...(workspaceChooserTab ? [workspaceChooserTab] : [])
    ],
    [navContentTabs, platformTabs, workspaceChooserTab]
  )

  /**
   * The billing scope is a plain route, not a workspace context switch: the
   * account is named in the URL and the API scopes on membership, so there is
   * no workspace to select and none of the context machinery applies.
   */
  const openCustomer = (customerId: string) => {
    navigate(buildBillingScopePath(customerId))
  }

  const openPlatformWorkspace = (routePath: string) => {
    setPendingWorkspaceRoute({ routePath, targetWorkspaceId: null, sourcePathname: appPathname })
    selectWorkspaceContext.mutate({ workspaceId: null, routePath })
  }

  const openWorkspace = (workspaceId: string, routePath: string) => {
    const workspaceSlug = workspaceSlugById.get(workspaceId)
    if (!workspaceSlug) return

    setPendingWorkspaceRoute({ routePath, targetWorkspaceId: workspaceId, sourcePathname: appPathname })
    if (isPlatformUser) {
      selectWorkspaceContext.mutate({ workspaceId, workspaceSlug, routePath })
      return
    }

    switchWorkspace.mutate({ workspaceId, workspaceSlug, routePath })
  }

  const openWorkspaceChooser = () => {
    if (isNativeApp()) {
      void PrintStreamInstance.menu({ view: 'switcher' }).catch(() => {
        console.warn('Could not open the native switcher.')
        navigate(buildWorkspaceSelectionPath())
      })
      return
    }
    navigate(buildWorkspaceSelectionPath())
  }

  // Land a connect-bridge deep link on the chosen workspace's Bridges page with
  // the code stashed for pre-fill. The connect API is bound to the active workspace
  // context, so a non-active workspace is switched into first (the switch
  // mutation then navigates straight to the Bridges page via its routePath).
  const connectBridgeToWorkspace = (workspaceId: string) => {
    if (!connectBridgeCode) return
    const workspaceSlug = workspaceId === activeWorkspaceId
      ? (activeWorkspaceSlug ?? workspaceSlugById.get(workspaceId))
      : workspaceSlugById.get(workspaceId)
    if (!workspaceSlug) return
    stashPendingBridgeConnectCode(connectBridgeCode)
    const bridgesRoutePath = '/settings/bridges'
    if (workspaceId === activeWorkspaceId) {
      navigate(buildWorkspacePath(workspaceSlug, bridgesRoutePath))
      return
    }
    if (isPlatformUser) {
      selectWorkspaceContext.mutate({ workspaceId, workspaceSlug, routePath: bridgesRoutePath })
      return
    }
    switchWorkspace.mutate({ workspaceId, workspaceSlug, routePath: bridgesRoutePath })
  }

  const renderWorkspaceContextElement = (element: ReactNode) => {
    if (!authBootstrapReady) {
      return <Typography>Loading…</Typography>
    }

    if (authRouteState === 'auth') {
      return <AuthView redirectPath={currentRoute} />
    }

    if (workspaceRouteRedirect == null) {
      if (!hasWorkspaceContext) {
        return <Typography>Loading…</Typography>
      }
      return renderProtectedElement(element)
    }

    return <Navigate to={workspaceRouteRedirect} replace />
  }

  const renderProtectedElement = (element: ReactNode) => {
    const protectedRouteState = resolveProtectedRouteState({
      authBootstrapReady,
      authEnabled,
      authSetupRequired,
      authProviderSetupAvailable,
      allowSetup: !hasWorkspaceContext,
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
      : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
  }

  useEffect(() => {
    completeSplashScreen()
  }, [])

  const sharedUnconstrainedWidth = generalSettingsQuery.data?.unconstrainedWidth ?? false
  const sharedAppTheme = generalSettingsQuery.data?.appTheme ?? 'default'
  const effectiveUnconstrainedWidth = deviceUnconstrainedWidthOverride ?? sharedUnconstrainedWidth
  // Computed from the workspace tabs; the billing scope overrides it below,
  // once its own tab set exists.
  const workspaceActiveTab = resolveActiveNavTab(tabs.map((tab) => tab.value), appPathname)
  const usesPlatformTheme = shouldUsePlatformAuthTheme({
    hasWorkspaceContext,
    canUsePlatformWorkspace,
    authRouteState
  })
  // Marketing and public info pages are brand surfaces with no theme
  // setting, so they always render the default theme. Platform surfaces use
  // their own device override paired with the platform-scoped shared setting
  // (`/api/settings` resolves the `platform:` scope there); workspace surfaces
  // keep the workspace override.
  // The billing scope is its own case: it has no workspace context, so it used
  // to read the shared setting -- which, asked without a workspace, answers with
  // the PLATFORM's. A customer's billing pages were styled by the operator's
  // choice. It now uses its own device override and falls back to the default.
  const themeInBillingScope = location.pathname.startsWith('/billing/')
  const effectiveAppTheme: AppThemeSetting = (isMarketingRoute || isPublicInfoRoute)
    ? 'default'
    : themeInBillingScope
      ? (deviceBillingAppThemeOverride ?? (usesPlatformTheme ? sharedAppTheme : 'default'))
      : (usesPlatformTheme ? devicePlatformAppThemeOverride : deviceAppThemeOverride) ?? sharedAppTheme
  const flatThemeVariant = isFlatAppTheme(effectiveAppTheme)
    ? (usesPlatformTheme ? platformFlatThemeVariants : flatThemeVariants)[effectiveAppTheme]
    : null
  const workspaceChrome = flatThemeVariant
    ? flatThemeVariant.chrome
    : effectiveAppTheme === 'aurora'
      ? (usesPlatformTheme ? platformAuroraChrome : auroraChrome)
      : (usesPlatformTheme ? platformChrome : defaultChrome)
  const workspaceChromeVars = useMemo(
    () => buildChromeCssVars(workspaceChrome),
    [workspaceChrome]
  )
  const workspaceTheme = flatThemeVariant
    ? flatThemeVariant.theme
    : effectiveAppTheme === 'aurora'
      ? (usesPlatformTheme ? platformAuroraTheme : auroraTheme)
      : (usesPlatformTheme ? platformTheme : theme)
  const usesPublicChrome = appPathname === '/billing' || isWorkspaceSelectionRoute || isConnectBridgeRoute || isMarketingRoute || isPublicInfoRoute
  /**
   * The billing scope carries no content tabs of its own.
   *
   * It is neither a workspace nor the platform, so it must not inherit either
   * one's navigation, which it otherwise does, because the shell keeps showing
   * whichever context the browser was last in. Landing on a customer's licences
   * under a row of Printers/Library/Jobs tabs (or the platform's Workspaces and
   * Suggestions) invites a click that leaves the page it was meant to be.
   */
  const inBillingScope = location.pathname.startsWith('/billing/')
  const billingScopeAccountId = parseBillingScopePath(location.pathname)?.customerId ?? null
  /**
   * The billing scope's own tabs.
   *
   * Its sections ARE the scope's navigation, so they take the shell's main tab
   * row exactly as a workspace's pages do: the workspace content tabs are what
   * belonged to a scope this is not, and they are the ones dropped. The
   * switcher and account tabs stay: dropping every tab once took the switcher
   * with it and left the scope with no exit but the browser's back button.
   */
  const billingScopeTabs = useMemo<ReadonlyArray<ShellTab>>(
    () => [
      ...(billingScopeAccountId
        ? billingScopeSections.filter((entry) => entry.id !== 'settings').map((entry) => ({
            value: buildBillingScopePath(billingScopeAccountId, entry.id),
            label: entry.label,
            ...(entry.description ? { description: entry.description } : {}),
            icon: BILLING_SCOPE_SECTION_ICONS[entry.id],
            // Like every workspace tab: the mobile dock renders icon-only
            // (label in the tooltip), with labels, seven tabs overflow a
            // 375px dock.
            mobileIcon: BILLING_SCOPE_SECTION_ICONS[entry.id]
          }))
        : []),
      ...(workspaceChooserTab ? [workspaceChooserTab] : [])
    ],
    [billingScopeAccountId, workspaceChooserTab]
  )
  const shellTabs = usesPublicChrome ? [] : inBillingScope ? billingScopeTabs : tabs
  const activeTab = inBillingScope
    ? resolveActiveNavTab(billingScopeTabs.map((tab) => tab.value), location.pathname)
    : workspaceActiveTab
  const shellWorkspaceLabel = usesPublicChrome
    ? undefined
    : inBillingScope ? BILLING_SCOPE_LABEL : (inPlatformMode ? 'Platform' : undefined)
  // In the billing scope the chooser must name the ACCOUNT. Without this branch
  // it fell through to the platform fallback and a customer's own billing pages
  // announced "Platform" as the current context.
  const billingScopeAccountName = billingScopeAccountId
    ? customerOptions.find((customer) => customer.id === billingScopeAccountId)?.name
    : undefined
  const shellWorkspaceChooserLabel = usesPublicChrome
    ? undefined
    : inBillingScope
      ? (billingScopeAccountName ?? BILLING_SCOPE_LABEL)
      : currentWorkspaceChooserLabel
  const shellWorkspaceChooserIcon = usesPublicChrome ? undefined : <SwapHorizRoundedIcon />
  const shellWorkspaceChooserAvailable = !usesPublicChrome && (canUseWorkspaceChooser || isNativeApp())
  const appFooterTrailing = (
    <Stack spacing={0.75} alignItems="center" useFlexGap>
      <AppVersionFooter />
    </Stack>
  )
  const shouldAutoSelectOnlyWorkspace = !isNativeApp() && authBootstrapReady
    && isAuthenticated
    && !isMarketingRoute
    && !isPublicInfoRoute
    && !hasWorkspaceContext
    && !canUsePlatformWorkspace
    && memberWorkspaceOptions.length === 1
  const workspaceStatsRouteElement = renderWorkspaceContextElement(
    <WorkspaceStatsView />
  )
  const workspaceGetStartedRouteElement = renderWorkspaceContextElement(
    generalSettingsQuery.data == null
      ? <Typography>Loading…</Typography>
      : quickStartDismissed
        ? <Navigate to={defaultRoute} replace />
        : (
            <GetStartedView
              canOpenSettings={canOpenWorkspaceSettings}
              canManageSettings={canManageSettings}
            />
          )
  )
  const workspaceSettingsPath = activeWorkspaceSlug ? buildWorkspacePath(activeWorkspaceSlug, '/settings') : buildWorkspaceSelectionPath()
  const accountPath = inPlatformMode
    ? '/platform/account'
    : activeWorkspaceSlug
      ? buildWorkspacePath(activeWorkspaceSlug, '/account')
      : buildWorkspaceSelectionPath()
  const footerSettingsPath = inBillingScope && billingScopeAccountId
    ? buildBillingScopePath(billingScopeAccountId, 'settings')
    : inPlatformMode
      ? '/platform/settings'
      : workspaceSettingsPath
  // Primary footer actions stay together as one wrapping unit beside the
  // user/workspace unit. Platform users staff the support inbox, so Help is
  // hidden there. Settings remains the final, persistent utility action.
  const appFooterActions = (
    <>
      {selfHostedDeployment && hasWorkspaceContext && canManageSettings && (
        <NativeBillingButton />
      )}
      {!inPlatformMode && <HelpFeedbackButton />}
      <PluginSlot name="shell.footer" />
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        startDecorator={<SettingsRoundedIcon />}
        onClick={() => navigate(footerSettingsPath)}
      >
        Settings
      </Button>
    </>
  )
  const platformOverviewRouteElement = renderProtectedElement(
    canUsePlatformWorkspace
      ? (inPlatformMode
          ? platformAdmin
            ? <platformAdmin.OverviewView />
            : <Navigate to="/platform/settings" replace />
          : pendingWorkspaceRoute != null && pendingWorkspaceRoute.targetWorkspaceId == null
            ? <Typography>Opening workspace…</Typography>
            : <Navigate to={buildWorkspaceSelectionPath()} replace />)
      : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
  )
  const publicRouteContext = {
    isAuthenticated,
    authPending: !authBootstrapReady,
    appHref: defaultRoute,
    // Billing/upgrade CTAs land on the account page (its Billing section), not
    // the workspace landing; without an active workspace fall back to the app entry.
    accountHref: activeWorkspaceSlug ? buildWorkspacePath(activeWorkspaceSlug, '/account') : defaultRoute,
    // The first account, which is the only one for everyone who is not an
    // operator; a purchase CTA has no way to ask which, and the buyer can move
    // it afterwards. Null leaves the CTA on its signed-out path.
    customerBasePath: customerOptions[0]
      ? customerApiBase(customerOptions[0].id)
      : null,
    billingMessagesHref: customerOptions[0]
      ? buildBillingScopePath(customerOptions[0].id, 'messages')
      : null,
    demoLandingRoute: publicDemoLandingRoute
  }
  const marketingRootRoute = marketingRoutes.find((route) => route.path === '/')
  // Without a marketing module, `/` routes straight into the app.
  const rootRouteElement = marketingRootRoute
    ? marketingRootRoute.render(publicRouteContext)
    : workspaceLandingRouteReady
      ? <Navigate to={defaultRoute} replace />
      : <Typography>Loading…</Typography>

  useEffect(() => {
    if (typeof document === 'undefined') return
    for (const [key, value] of Object.entries(workspaceChromeVars)) {
      document.documentElement.style.setProperty(key, value)
    }
  }, [workspaceChromeVars])

  // Keep the browser/PWA chrome color on the painted theme, and cache the
  // theme background so the next boot's splash (index.html pre-bundle script)
  // matches it instead of flashing a mismatched backdrop. Brand surfaces
  // (marketing/public info) force the Default theme and do not represent the
  // user's choice, so they update the meta tag but never overwrite the cache.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const themeBodyColor = workspaceTheme.colorSchemes.dark.palette.background.body
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeBodyColor)
    if (isMarketingRoute || isPublicInfoRoute) return
    try {
      window.localStorage.setItem(BOOT_BACKGROUND_CACHE_KEY, JSON.stringify({
        background: workspaceChrome.bodyBackground,
        color: themeBodyColor
      }))
    } catch {
      /* best-effort; private browsing or full storage just keeps the neutral boot tone */
    }
  }, [workspaceChrome, workspaceTheme, isMarketingRoute, isPublicInfoRoute])

  useEffect(() => {
    if (!shouldAutoSelectOnlyWorkspace) {
      return
    }
    if (appPathname !== workspaceEntryRoute) {
      return
    }
    if (workspaceSwitchPending || pendingWorkspaceRoute) {
      return
    }

    const onlyWorkspaceOption = memberWorkspaceOptions[0]
    if (!onlyWorkspaceOption) {
      return
    }

    const onlyWorkspaceSlug = workspaceSlugById.get(onlyWorkspaceOption.id)
    if (!onlyWorkspaceSlug) {
      return
    }

    setPendingWorkspaceRoute({
      routePath: workspaceEntryRoute,
      targetWorkspaceId: onlyWorkspaceOption.id,
      sourcePathname: appPathname
    })
    switchWorkspace.mutate({
      workspaceId: onlyWorkspaceOption.id,
      workspaceSlug: onlyWorkspaceSlug,
      routePath: workspaceEntryRoute
    })
  }, [
    appPathname,
    memberWorkspaceOptions,
    pendingWorkspaceRoute,
    shouldAutoSelectOnlyWorkspace,
    switchWorkspace,
    workspaceEntryRoute,
    workspaceSlugById,
    workspaceSwitchPending
  ])

  useEffect(() => {
    if (!pendingWorkspaceRoute) {
      return
    }
    if (!authBootstrapReady) {
      return
    }
    if (pendingWorkspaceRoute.targetWorkspaceId == null) {
      if (hasWorkspaceContext) {
        return
      }
    } else if (activeWorkspaceId !== pendingWorkspaceRoute.targetWorkspaceId) {
      return
    }

    const resolvedDestination = resolveWorkspaceSwitchDestination({
      currentPath: pendingWorkspaceRoute.routePath,
      defaultPath: defaultTab,
      inPlatformMode,
      canUsePlatformWorkspace,
      hasWorkspaceContext,
      canViewPrinters,
      canViewLibrary,
      canViewJobs,
      canOpenSettings: canOpenWorkspaceSettings,
      canViewAccount: showsAccountTab,
      enabledPluginBasePaths,
      pluginStateReady: pluginStateQuery.data?.plugins != null
    })

    if (resolvedDestination == null) {
      return
    }

    const nextRoute = pendingWorkspaceRoute.targetWorkspaceId != null && activeWorkspaceSlug && isWorkspaceCandidatePath(resolvedDestination)
      ? buildWorkspacePath(activeWorkspaceSlug, resolvedDestination)
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
    hasWorkspaceContext,
    activeWorkspaceId,
    activeWorkspaceSlug,
    canViewPrinters,
    canViewLibrary,
    canViewJobs,
    canOpenWorkspaceSettings,
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
      <AppThemeProvider theme={workspaceTheme}>
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
                if (activeWorkspaceSlug && isWorkspaceCandidatePath(value)) {
                  navigate(buildWorkspacePath(activeWorkspaceSlug, value))
                  return
                }
                navigate(value)
              }}
              onOpenAccount={showsAccountTab ? () => navigate(accountPath) : undefined}
              workspaceLabel={shellWorkspaceLabel}
              workspaceChooserLabel={shellWorkspaceChooserLabel}
              workspaceChooserIcon={shellWorkspaceChooserIcon}
              showNavigationFrame={false}
              unconstrainedWidth={effectiveUnconstrainedWidth}
              identity={isMarketingRoute || isPublicInfoRoute ? null : shellIdentity}
              identityIcon={<AccountCircleRoundedIcon />}
              workspaceChooserAvailable={shellWorkspaceChooserAvailable}
              onOpenWorkspaceChooser={openWorkspaceChooser}
              workspaceChooserPending={workspaceSwitchPending}
              onLogoClick={() => navigate('/')}
              footerActions={(isMarketingRoute || isPublicInfoRoute) ? undefined : appFooterActions}
              footerTrailing={(isMarketingRoute || isPublicInfoRoute)
                ? (marketing ? <marketing.Footer /> : undefined)
                : appFooterTrailing}
            >
              {disabledActivePluginRoute ? <Navigate to={inPlatformMode ? '/platform/settings/plugins' : `${workspaceSettingsPath}/plugins`} replace /> : null}
              <AuthBootstrapQueryProvider value={authBootstrapQuery}>
                <PluginCatalogQueryProvider value={pluginStateQuery}>
                  <PrintDispatchJobsQueryProvider value={shellDispatchQuery}>
                    <ScrollReset />
                    {/* Headless plugin components that sync app-level state (e.g. unread badges). */}
                    <PluginSlot name="shell.background" />
                    {/* App-level overlay dialogs contributed by plugins (e.g. the post-sign-in
                        passkey setup offer). Static slot: auth surfaces must render without
                        consulting the plugin catalog. */}
                    <StaticPluginSlot name="shell.overlays" />
                    {hasWorkspaceContext && <LicenseBanner />}
                    {hasWorkspaceContext && canManageSettings && <BridgeUpdateBanner />}
                    {hasWorkspaceContext && canManageSettings && <BridgeCrashBanner />}
                    {hasWorkspaceContext && canManageSettings && <BridgeDebugCaptureBanner />}
                    {hasWorkspaceContext && <LibraryUploadPanel />}
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
                      : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                  }
                />
                <Route
                  path="/connect-bridge"
                  element={renderProtectedElement(
                    <ConnectBridgeView
                      code={connectBridgeCode}
                      workspaces={switchableWorkspaceOptions}
                      activeWorkspaceId={activeWorkspaceId}
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
                            workspaceOptions={switchableWorkspaceOptions}
                            customerOptions={customerOptions}
                            allowPlatformSelection={canUsePlatformWorkspace}
                            onPlatformSelect={canUsePlatformWorkspace ? () => openPlatformWorkspace(platformWorkspaceLandingRoute) : undefined}
                            onCustomerSelect={hasBillingScopeView ? openCustomer : undefined}
                            onWorkspaceSelect={(workspaceId) => openWorkspace(workspaceId, workspaceEntryRoute)}
                            selectionPending={workspaceSwitchPending}
                          />
                        )
                      : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                  )}
                />
                <Route
                  path="/workspaces/:workspaceSlug"
                  element={workspaceLandingRouteReady ? <Navigate to={workspaceLandingRoute.slice(1)} replace /> : <Typography>Loading…</Typography>}
                />
                <Route
                  path="/platform"
                  element={platformOverviewRouteElement}
                />
                <Route
                  path="/platform/settings/*"
                  element={renderProtectedElement(
                    canUsePlatformWorkspace
                      ? (inPlatformMode
                          ? (
                              <PlatformView
                                sharedAppTheme={sharedAppTheme}
                                deviceAppThemeOverride={devicePlatformAppThemeOverride}
                                sharedSettingsError={generalSettingsQuery.error ? extractErrorMessage(generalSettingsQuery.error) : null}
                                sharedSettingsSaving={updateGeneralSettings.isPending}
                                sharedSettingsSaveError={updateGeneralSettings.error ? extractErrorMessage(updateGeneralSettings.error) : null}
                                onSetSharedAppTheme={(appTheme) => updateGeneralSettings.mutate({ appTheme })}
                                onSetDeviceAppTheme={setDevicePlatformAppThemeOverride}
                                onClearDeviceAppThemeOverride={() => setDevicePlatformAppThemeOverride(null)}
                              />
                            )
                          : <Navigate to={workspaceSettingsPath} replace />)
                      : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                  )}
                />
                {platformAdmin ? (
                  <Route
                    path="/platform/workspaces"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace
                        ? (
                            inPlatformMode
                              ? (
                                  <platformAdmin.WorkspacesView
                                    canDisableWorkspaces={canDisableWorkspaces}
                                    canManageWorkspaces={canManageWorkspaces}
                                    accessibleWorkspaceIds={workspaceDirectoryAccessibleWorkspaceIds}
                                    onOpenWorkspace={(workspaceId) => {
                                      openWorkspace(workspaceId, workspaceEntryRoute)
                                    }}
                                  />
                                )
                              : pendingWorkspaceRoute?.targetWorkspaceId != null
                                ? <Typography>Opening workspace…</Typography>
                                : <Navigate to={workspaceSettingsPath} replace />
                          )
                        : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                {platformAdmin ? (
                  <Route
                    path="/platform/licenses"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace && inPlatformMode
                        ? <platformAdmin.LicensesView />
                        : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                {platformAdmin ? (
                  <Route
                    path="/platform/customers"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace && inPlatformMode
                        ? <platformAdmin.CustomersView />
                        : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                {platformAdmin ? (
                  <Route
                    path="/platform/customers/:customerId"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace && inPlatformMode
                        ? <platformAdmin.CustomerDetailView />
                        : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                {platformAdmin ? (
                  <Route
                    path="/platform/messages"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace && inPlatformMode
                        ? <platformAdmin.MessagesView />
                        : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                {platformAdmin ? (
                  <Route
                    path="/platform/suggestions/*"
                    element={renderProtectedElement(
                      canUsePlatformWorkspace && inPlatformMode
                        ? <platformAdmin.SuggestionsView />
                        : workspaceLandingRouteReady ? <Navigate to={defaultRoute} replace /> : <Typography>Loading…</Typography>
                    )}
                  />
                ) : null}
                <Route path="/workspaces/:workspaceSlug/printers" element={renderWorkspaceContextElement(<PrintersView />)} />
                <Route path="/workspaces/:workspaceSlug/printers/views/:viewId" element={renderWorkspaceContextElement(<PrintersView />)} />
                <Route path="/workspaces/:workspaceSlug/printers/:printerId" element={renderWorkspaceContextElement(<PrintersView />)} />
                <Route path="/workspaces/:workspaceSlug/library" element={renderWorkspaceContextElement(<LibraryView />)} />
                {/* Static `favorites` outranks the `:folderId` route below, giving the favorites view its own bookmarkable URL. */}
                <Route path="/workspaces/:workspaceSlug/library/favorites" element={renderWorkspaceContextElement(<LibraryView />)} />
                <Route path="/workspaces/:workspaceSlug/library/:folderId" element={renderWorkspaceContextElement(<LibraryView />)} />
                <Route path="/workspaces/:workspaceSlug/get-started" element={workspaceGetStartedRouteElement} />
                <Route path="/workspaces/:workspaceSlug/stats" element={workspaceStatsRouteElement} />
                <Route path="/workspaces/:workspaceSlug/jobs" element={renderWorkspaceContextElement(<JobsView />)} />
                <Route
                  path="/workspaces/:workspaceSlug/account"
                  element={renderWorkspaceContextElement(renderAccountElement())}
                />
                {/*
                  Billing and Messages are their own pages, not sections of
                  Account. Registered only when a plugin actually fills the
                  slot, so a public build (where both are empty) has no route
                  that renders a blank page.
                */}
                {/*
                  The billing scope. Outside the /workspaces tree because it is
                  not one: it has no workspace context, no printers, and no
                  workspace slug to hang off.
                */}
                {hasBillingScopeView && PrivateBillingEntryView && <Route path="/billing" element={renderProtectedElement(<PrivateBillingEntryView />)} />}
                {hasBillingScopeView ? (
                  <Route
                    path={BILLING_SCOPE_ROUTE}
                    element={renderProtectedElement(<BillingScopeView />)}
                  />
                ) : null}
                {hasBillingScopeView ? (
                  <Route
                    path={BILLING_SCOPE_SECTION_ROUTE}
                    element={renderProtectedElement(<BillingScopeView />)}
                  />
                ) : null}
                {hasMessagesSlot ? (
                  <Route
                    path="/workspaces/:workspaceSlug/account/messages"
                    element={renderWorkspaceContextElement(<AccountSlotView slot={ACCOUNT_MESSAGES_SLOT} />)}
                  />
                ) : null}
                <Route
                  path="/platform/account"
                  element={renderAccountElement()}
                />
                {/* The platform's copy of the workspace route above. An
                    operator has an account of their own and reaches it with no
                    workspace selected, so the slot renders unwrapped, its list
                    is scoped to the user, not to a workspace. Without this the
                    Account page's own Messages link matched no route and the
                    catch-all sent the click to the home page. */}
                {hasMessagesSlot ? (
                  <Route
                    path="/platform/account/messages"
                    element={<AccountSlotView slot={ACCOUNT_MESSAGES_SLOT} />}
                  />
                ) : null}
                <Route
                  path="/workspaces/:workspaceSlug/settings/*"
                  element={inPlatformMode
                    ? <Navigate to="/platform/settings" replace />
                    : renderWorkspaceContextElement(
                        (canManageSettings || canManageWorkspaces || (canOpenWorkspaceAuthSettings && isWorkspaceAuthSettingsRoute) || (canOpenWorkspaceAuthSettings && appPathname === '/settings')) ? (
                          canOpenWorkspaceAuthSettings && !canManageSettings && !canManageWorkspaces && appPathname === '/settings'
                            ? <Navigate to={buildWorkspacePath(routeWorkspaceSlug ?? activeWorkspaceSlug ?? PUBLIC_DEMO_WORKSPACE_SLUG, '/settings/authentication')} replace />
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
                {mountedPluginRoutes.map((route) => {
                  const Element = route.element
                  return <Route key={`${route.pluginName}:scoped:${route.path}`} path={workspaceScopedRoutePath(route.path)} element={renderWorkspaceContextElement(<Element />)} />
                })}
                {/* A known plugin route (e.g. /orders) on a cold load isn't mounted yet while the plugin
                    catalog resolves: wait rather than redirect home. See catchAllRouteDecision. */}
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
                      {(authBootstrapReady && hasWorkspaceContext && isAuthenticated && canViewJobs) && <DispatchToasts />}
                      {(authBootstrapReady && hasWorkspaceContext && isAuthenticated && canUploadLibrary) && <SlicingToasts />}
                      {/* Beside the slice toasts, and gated the same way: the
                          people who need to know the slicer is still coming up
                          are exactly the people who can slice. */}
                      {(authBootstrapReady && hasWorkspaceContext && isAuthenticated && canUploadLibrary) && <EngineInstallToast />}
                      {(authBootstrapReady && hasWorkspaceContext && isAuthenticated && (canManageLibrary || canManagePrinters)) && <DeleteOperationToasts />}
                      <Toaster />
                    </StatusToastStack>
                  </PrintDispatchJobsQueryProvider>
                </PluginCatalogQueryProvider>
              </AuthBootstrapQueryProvider>
            </AppShell>
          )}
        </Box>
      </AppThemeProvider>
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
              <Button size="sm" variant="soft" color="neutral" onClick={() => window.location.assign('/workspaces')}>{WORKSPACE_CHOOSER_LABEL}</Button>
              <Button size="sm" variant="plain" color="neutral" onClick={() => window.location.reload()}>Reload</Button>
            </Stack>
          </Stack>
        </Alert>
      </Box>
    )
  }
}
