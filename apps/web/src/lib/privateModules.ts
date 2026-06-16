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

export interface PublicRouteContext {
  isAuthenticated: boolean
  /** Route into the app for the current actor (workspace landing or chooser). */
  appHref: string
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
  /** Nav tabs listed before the platform settings tab. */
  navTabs: ReadonlyArray<ShellTab>
}

export interface PrivateWebModule {
  name: string
  marketing?: PrivateMarketingModule
  platformAdmin?: PrivatePlatformAdminModule
}

const discovered = import.meta.glob('../private/*/index.tsx', { eager: true }) as Record<
  string,
  { default?: PrivateWebModule }
>

export const privateWebModules: ReadonlyArray<PrivateWebModule> = Object.keys(discovered)
  .sort()
  .map((key) => discovered[key]?.default)
  .filter((entry): entry is PrivateWebModule => Boolean(entry))

export const marketingModule: PrivateMarketingModule | null =
  privateWebModules.find((entry) => entry.marketing)?.marketing ?? null

export const platformAdminModule: PrivatePlatformAdminModule | null =
  privateWebModules.find((entry) => entry.platformAdmin)?.platformAdmin ?? null
