/**
 * Host for first-party private web modules under `src/private/<name>/`.
 *
 * The private directory holds the closed-source cloud surface (marketing
 * site, platform tenant administration) and is stripped from the public
 * open-source export, so discovery uses `import.meta.glob` — an empty or
 * missing directory simply yields no modules and the app must render its
 * core fallbacks (see App.tsx).
 *
 * Invariants:
 * - Private modules may import core components/libs; core code must never
 *   import from `src/private` directly — only through this host.
 * - Everything here must degrade gracefully when no module is present:
 *   `marketingModule` / `platformAdminModule` are simply `null`.
 */
import type { ComponentType, ReactNode } from 'react'
import type { ShellTab } from '../components/AppShell'
import type { WebPlugin } from '../plugin/types'

export interface PublicRouteContext {
  isAuthenticated: boolean
  /** Route into the app for the current actor (workspace landing or chooser). */
  appHref: string
  /**
   * Route to the actor's account page (billing lives there) — the workspace
   * account when a tenant is active, otherwise the same as `appHref`.
   */
  accountHref: string
  /** Where the public demo entry should land. */
  demoLandingRoute: string
}

export interface PrivatePublicRoute {
  path: string
  /**
   * Render with the public (marketing) chrome — no shell tabs or identity —
   * and skip the sign-in wall. Routes without it (e.g. pure redirects) still
   * bypass the auth gate but keep the default chrome.
   */
  publicChrome?: boolean
  render: (context: PublicRouteContext) => ReactNode
}

export interface PrivateMarketingModule {
  /** Public routes, including the marketing home at `/`. */
  routes: ReadonlyArray<PrivatePublicRoute>
  /** Footer rendered in the shell on public-chrome routes. */
  Footer: ComponentType
}

export interface PlatformTenantsViewProps {
  canDisableTenants: boolean
  canManageTenants: boolean
  accessibleTenantIds: ReadonlySet<string>
  onOpenWorkspace: (tenantId: string) => void
}

export interface PrivatePlatformAdminModule {
  /** Rendered at `/platform` (platform workspace landing). */
  OverviewView: ComponentType
  /** Rendered at `/platform/tenants`. */
  TenantsView: ComponentType<PlatformTenantsViewProps>
  /** Rendered at `/platform/billing` (gated by `billing.manage`). */
  BillingView: ComponentType
  /** Rendered at `/platform/messages` (the support-messaging inbox). */
  MessagesView: ComponentType
  /** Rendered at `/platform/suggestions/*` (the shared suggestion board; footer-linked, no nav tab). */
  SuggestionsView: ComponentType
  /** Nav tabs listed before the platform settings tab. */
  navTabs: ReadonlyArray<ShellTab>
}

export interface PrivateWebModule {
  name: string
  marketing?: PrivateMarketingModule
  platformAdmin?: PrivatePlatformAdminModule
  /**
   * Built-in web plugins shipped only in the cloud build (e.g. the auth-local
   * sign-in UI). Registered alongside the public built-ins; absent in OSS.
   */
  plugins?: ReadonlyArray<WebPlugin>
}

// `import.meta.glob` is a Vite build-time transform (the literal call form is
// required). Under `node --test` (no Vite) it is undefined and throws — guard so
// importing this module from the plugin host stays test-safe; the result there is
// simply no private modules, matching a public build.
let discovered: Record<string, { default?: PrivateWebModule }> = {}
try {
  discovered = import.meta.glob('../private/*/index.tsx', { eager: true }) as Record<
    string,
    { default?: PrivateWebModule }
  >
} catch {
  discovered = {}
}

export const privateWebModules: ReadonlyArray<PrivateWebModule> = Object.keys(discovered)
  .sort()
  .map((key) => discovered[key]?.default)
  .filter((entry): entry is PrivateWebModule => Boolean(entry))

export const marketingModule: PrivateMarketingModule | null =
  privateWebModules.find((entry) => entry.marketing)?.marketing ?? null

export const platformAdminModule: PrivatePlatformAdminModule | null =
  privateWebModules.find((entry) => entry.platformAdmin)?.platformAdmin ?? null

/** Cloud-only built-in web plugins (empty in OSS); registered with the public built-ins. */
export const privateWebPlugins: ReadonlyArray<WebPlugin> =
  privateWebModules.flatMap((entry) => entry.plugins ?? [])
