/**
 * Plugin contract for the API runtime.
 *
 * A plugin is a small object with a `name` and a `register` function. The
 * registrar receives an `ApiPluginContext` that exposes only the seams a
 * plugin should need: a logger, the shared Prisma client, the printer
 * event bus, an Express sub-router scoped under `/api/plugins/<name>`,
 * the WebSocket broadcaster, and a small key/value setting store.
 *
 * Plugins must remain optional. The core app must continue to function
 * if every plugin is removed. Conversely, a plugin must not assume any
 * other plugin is installed. Cross-plugin coordination should happen
 * through the public event/contract surface, not by importing each
 * other directly.
 *
 * Built-in plugins live under `apps/api/src/plugins/<name>/` and are wired up
 * in `apps/api/src/plugin/builtin.ts`, where `pluginRegistry.register` sets
 * their install/enable defaults (`defaultEnabled`), runtime/manager surfaces,
 * and `tenantAccess`. A built-in plugin may own tenant-scoped Prisma models in
 * the core schema (see the `orders` plugin); plugins persisting only small
 * config should use the `settings` store.
 *
 * Third-party plugins ship as `.zip` archives (a `plugin.json` manifest plus
 * an ESM entry whose default export is an `ApiPlugin`), uploaded through
 * `/api/admin/plugins` and installed/loaded by `plugin/installer.ts`. Because
 * they cannot migrate the core schema, they must persist through the
 * `settings` store only. Web plugins are still built ahead of time, so an
 * uploaded plugin's `web` field is accepted but ignored for now.
 */
import type { Router } from 'express'
import type { PluginCatalogEntry, PluginManagementEntry, PluginSurface, PluginTenantAccess, PluginSource, TenantPluginAvailability } from '@printstream/shared'
import type { PrinterEventBus } from '../lib/printer-events.js'
import type { RegisteredAuthProvider, RegisteredAuthProviderResolver } from '../lib/auth-registry.js'
import type { PrintGuard } from '../lib/print-guards.js'
import type { SlotFilamentResolver } from '../lib/slot-filament-registry.js'
import type { TenantScopedPrismaClient } from '../lib/prisma.js'
import type { WsBroadcaster } from '../lib/ws-server.js'

export interface PluginLogger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

export interface PluginSettingStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  /**
   * Return a sub-store whose keys are automatically prefixed with the
   * tenant ID. Use this for per-tenant configuration (webhook URLs,
   * push subscriptions, etc.) so tenants cannot see or overwrite each
   * other's settings.
   */
  forTenant(tenantId: string): PluginSettingStore
}

export interface ApiPluginContext {
  pluginName: string
  logger: PluginLogger
  prisma: TenantScopedPrismaClient
  printerEvents: PrinterEventBus
  ws: WsBroadcaster
  /**
   * Whether this plugin is currently enabled for the given scope.
   * Background listeners and printer-event handlers should consult this
   * before doing scoped work outside the HTTP router. `null` asks about the
   * platform (tenantless) scope: true when the plugin runs on the platform
   * surface and is platform-enabled.
   */
  isEnabledForTenant?(tenantId: string | null): boolean
  /**
   * Sub-router automatically mounted at `/api/plugins/<pluginName>`.
   * Plugins should attach any HTTP routes here rather than touching the
   * top-level Express app.
   */
  router: Router
  /**
   * Scoped key/value store backed by the `Setting` table. Keys are
   * automatically prefixed with the plugin name so two plugins cannot
   * collide.
   */
  settings: PluginSettingStore
  /**
   * Register a teardown function that runs when the plugin is stopped
   * (process shutdown, hot reload). Optional but recommended for any
   * plugin that opens external connections or starts timers.
   */
  onShutdown(handler: () => void | Promise<void>): void
  /**
   * Register a print guard. Every print attempt (initial dispatch and
   * SD-card reprints) is vetted by the union of all registered guards;
   * if any returns `false` (or `{ allowed: false, reason }`) the
   * request is rejected with HTTP 409 and `reason` surfaces in the UI.
   * Returns an unsubscribe handle the plugin should call from its
   * shutdown handler.
   */
  registerPrintGuard(guard: PrintGuard): () => void
  /**
   * Register a public auth provider descriptor for `/api/auth/bootstrap`.
   * The registry entry is automatically removed when the plugin stops.
   */
  registerAuthProvider(provider: RegisteredAuthProvider | RegisteredAuthProviderResolver): () => void
  /**
   * Register a resolver that maps an AMS slot to the filament/spool loaded in
   * it. A plugin owning filament inventory registers one; other plugins consult
   * `slotFilamentResolvers` to learn a slot's spool without importing this one.
   * The resolver is only consulted for tenants this plugin is enabled for, and
   * is removed automatically when the plugin stops.
   */
  registerSlotFilamentResolver(resolver: SlotFilamentResolver): () => void
}

export interface ApiPlugin {
  name: string
  version?: string
  /** Short, user-facing description shown in the plugin manager UI. */
  description?: string
  runtimeSurfaces?: PluginSurface[]
  managerSurfaces?: PluginSurface[]
  tenantAccess?: PluginTenantAccess
  register(context: ApiPluginContext): void | Promise<void>
}

export type PluginInfo = PluginManagementEntry
export type PublicPluginInfo = PluginCatalogEntry
export type { PluginSurface, PluginTenantAccess, PluginSource, TenantPluginAvailability }
