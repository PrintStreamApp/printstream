/**
 * Host for first-party private web modules under `src/private/<name>/`.
 *
 * The private directory holds the closed-source cloud surface (marketing
 * site, platform workspace administration) and is stripped from the public
 * open-source export, so discovery uses `import.meta.glob`, an empty or
 * missing directory simply yields no modules and the app must render its
 * core fallbacks (see App.tsx).
 *
 * Invariants:
 * - Private modules may import core components/libs; core code must never
 *   import from `src/private` directly, only through this host.
 * - Everything here must degrade gracefully when no module is present:
 *   `marketingModule` / `platformAdminModule` are simply `null`.
 */
import type { ComponentType, ReactNode } from 'react'
import type { ShellTab } from '../components/AppShell'
import type { WebPlugin } from '../plugin/types'

export interface PublicRouteContext {
  isAuthenticated: boolean
  /**
   * Auth is still being determined, so `isAuthenticated` means "not known yet"
   * rather than "signed out".
   *
   * Marketing CTAs swap on sign-in state ("Login" becomes "Open app", a plan
   * button becomes a purchase), and painting the signed-OUT branch first told a
   * signed-in reader to log in and then changed its mind. False once settled,
   * and false from the start where nobody is asking -- so a surface can render
   * its neutral state while this is true instead of guessing.
   */
  authPending?: boolean
  /** Route into the app for the current actor (workspace landing or chooser). */
  appHref: string
  /**
   * Route to the actor's account page (billing lives there): the workspace
   * account when a workspace is active, otherwise the same as `appHref`.
   */
  accountHref: string
  /**
   * The signed-in actor's billing-account API base, or null.
   *
   * Marketing carries no workspace, so a purchase CTA on a public page cannot
   * use a workspace-scoped endpoint -- for a buyer with no workspace at all
   * (which is what registering for a self-hosted licence creates) it 403s.
   * Null on a cold marketing load and for a signed-out visitor, who is sent to
   * register first.
   */
  customerBasePath?: string | null
  /** Where the public demo entry should land. */
  demoLandingRoute: string
}

export interface PrivatePublicRoute {
  path: string
  /**
   * Render with the public (marketing) chrome, no shell tabs or identity,
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

export interface PlatformWorkspacesViewProps {
  canDisableWorkspaces: boolean
  canManageWorkspaces: boolean
  accessibleWorkspaceIds: ReadonlySet<string>
  onOpenWorkspace: (workspaceId: string) => void
}

export interface PrivatePlatformAdminModule {
  /** Rendered at `/platform` (platform workspace landing). */
  OverviewView: ComponentType
  /** Rendered at `/platform/workspaces`. */
  WorkspacesView: ComponentType<PlatformWorkspacesViewProps>
  /** Rendered at `/platform/licenses` (issued self-hosted keys). */
  LicensesView: ComponentType
  /** Rendered at `/platform/customers` (the level above workspaces). */
  CustomersView: ComponentType
  /** One customer in full, inside the platform rather than their own scope. */
  CustomerDetailView: ComponentType
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
// required). Under `node --test` (no Vite) it is undefined and throws: guard so
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
