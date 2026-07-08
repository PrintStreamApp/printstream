/**
 * Plugin registry. Owns plugin lifecycle (register + shutdown) and gives
 * each plugin a scoped Express router, settings store, and logger.
 *
 * Plugins have two independent state bits, both persisted in the
 * `Setting` table so they survive restarts:
 *
 * - `installed` — whether the plugin is provisioned at all. Uninstalling
 *   deactivates the plugin and clears every scoped `Setting` row except
 *   the install flag itself, so the plugin starts from a clean slate
 *   when reinstalled. Requests to an uninstalled plugin's sub-router
 *   return 404.
 * - `enabled` — whether an installed platform-scoped plugin is active.
 *   Tenant-scoped plugins keep their own tenant-local enablement while the
 *   platform stores only the allow/default policy for tenant workspaces.
 *
 * Background work (event listeners, timers, sockets) is torn down by
 * invoking the shutdown handlers the plugin registered, and re-created
 * by calling `register` again on enable/install.
 *
 * State is persisted under `plugin:<name>:_installed`,
 * `plugin:<name>:_enabled`, and tenant-policy keys for controlled
 * tenant plugins.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express'
import type { PluginSurface, PluginTenantAccess, PluginSource, TenantPluginAvailability } from '@printstream/shared'
import type { ApiPlugin, ApiPluginContext, PluginInfo, PluginLogger, PluginSettingStore, PublicPluginInfo } from './types.js'
import { authProviderRegistry } from '../lib/auth-registry.js'
import type { PrintGuardContext } from '../lib/print-guards.js'
import { prisma } from '../lib/prisma.js'
import { printerEvents } from '../lib/printer-events.js'
import { printerManager } from '../lib/printer-manager.js'
import { printGuards } from '../lib/print-guards.js'
import { slotFilamentResolvers, type SlotFilamentResolver } from '../lib/slot-filament-registry.js'
import { wsBroadcaster } from '../lib/ws-server.js'
import { blockedPluginsForTenant, planGatedPluginNames } from '../lib/plugin-plan-gate.js'
import { broadcastPluginSettingsChanged, broadcastPluginsChanged } from '../lib/ws-resource-events.js'
import {
  derivePluginDefaultEnableMode,
  isPluginEnabledByDefault,
  PLUGIN_DEFAULT_ENABLE_MODE_KEY,
  type PluginDefaultEnableMode
} from './default-enable-mode.js'

interface RegisteredPlugin {
  plugin: ApiPlugin
  source: PluginSource
  installed: boolean
  enabled: boolean
  active: boolean
  runtimeSurfaces: PluginSurface[]
  managerSurfaces: PluginSurface[]
  tenantAccess: PluginTenantAccess
  tenantAvailability: {
    allowed: boolean
    enabledByDefault: boolean
  }
  tenantEnabledOverrides: Map<string, boolean>
  pluginRouter: Router
  shutdownHandlers: Array<() => void | Promise<void>>
}

const ENABLED_KEY = '_enabled'
const INSTALLED_KEY = '_installed'
const TENANT_DEFAULT_ALLOWED_KEY = '_tenantDefaultAllowed'
const TENANT_DEFAULT_ENABLED_KEY = '_tenantDefaultEnabled'
const TENANT_ENABLED_OVERRIDE_PREFIX = '_tenantEnabled:'
const LEGACY_TENANT_OVERRIDE_PREFIX = '_tenantAllowed:'
/** Internal keys that are never cleared on uninstall. */
const RESERVED_KEYS = new Set([ENABLED_KEY, INSTALLED_KEY, TENANT_DEFAULT_ALLOWED_KEY, TENANT_DEFAULT_ENABLED_KEY])

export class PluginRegistry {
  private readonly registered = new Map<string, RegisteredPlugin>()
  private defaultEnableModePromise: Promise<PluginDefaultEnableMode> | null = null
  /** Top-level router mounted at `/api/plugins`; one sub-router per plugin. */
  readonly router: Router = express.Router()

  async register(plugin: ApiPlugin, options: {
    source?: PluginSource
    defaultEnabled?: boolean
    forceInstalled?: boolean
    forceEnabled?: boolean
    runtimeSurfaces?: PluginSurface[]
    managerSurfaces?: PluginSurface[]
    tenantAccess?: PluginTenantAccess
  } = {}): Promise<void> {
    if (this.registered.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`)
    }

    const pluginRouter = express.Router()
    const runtimeSurfaces = normalizePluginSurfaces(options.runtimeSurfaces ?? plugin.runtimeSurfaces ?? ['tenant'])
    const managerSurfaces = normalizePluginSurfaces(options.managerSurfaces ?? plugin.managerSurfaces ?? defaultManagerSurfaces(runtimeSurfaces))
    const tenantAccess = normalizeTenantAccess(options.tenantAccess ?? plugin.tenantAccess ?? defaultTenantAccess(runtimeSurfaces))
    validatePluginMetadata(plugin.name, runtimeSurfaces, managerSurfaces, tenantAccess)
    const entry: RegisteredPlugin = {
      plugin,
      source: options.source ?? 'builtin',
      installed: true,
      enabled: true,
      active: false,
      runtimeSurfaces,
      managerSurfaces,
      tenantAccess,
      tenantAvailability: {
        allowed: tenantAccess === 'controlled',
        enabledByDefault: false
      },
      tenantEnabledOverrides: new Map(),
      pluginRouter,
      shutdownHandlers: []
    }
    this.registered.set(plugin.name, entry)

    // Guard runs before the plugin's own routes so install/enable state
    // can change without re-mounting routers. The order matters: an
    // uninstalled plugin reads as "not found", a disabled-but-installed
    // plugin reads as "service unavailable", and a plan-gated plugin reads
    // as "forbidden" (the workspace's plan doesn't include it).
    this.router.use(`/${plugin.name}`, (request: Request, response: Response, next: NextFunction) => {
      const current = this.registered.get(plugin.name)
      if (!current?.installed) {
        response.status(404).json({ error: `Plugin not installed: ${plugin.name}` })
        return
      }
      if (!this.isAvailableInRequestContext(current, request)) {
        response.status(404).json({ error: `Plugin unavailable in this workspace: ${plugin.name}` })
        return
      }
      if (!this.isEnabledInRequestContext(current, request)) {
        response.status(503).json({ error: `Plugin disabled: ${plugin.name}` })
        return
      }
      const tenantId = request.tenant?.id
      if (tenantId && planGatedPluginNames().has(plugin.name)) {
        void blockedPluginsForTenant(tenantId)
          .then((blocked) => {
            if (blocked.has(plugin.name)) {
              response.status(403).json({ error: `This plugin requires the Pro plan: ${plugin.name}` })
              return
            }
            next()
          })
          .catch(next)
        return
      }
      next()
    })
    this.router.use(`/${plugin.name}`, pluginRouter)

    const settings = createSettingStore(plugin.name)
    const installedRaw = await settings.get(INSTALLED_KEY)
    const enabledRaw = await settings.get(ENABLED_KEY)
    const enabledByDefault = options.defaultEnabled ?? isPluginEnabledByDefault(await this.getDefaultEnableMode())
    entry.installed = options.forceInstalled ?? (installedRaw == null ? true : installedRaw !== 'false')
    entry.enabled = options.forceEnabled ?? (enabledRaw == null ? enabledByDefault : enabledRaw !== 'false')
    entry.tenantAvailability = await this.loadTenantAvailability(plugin.name, {
      allowed: entry.tenantAccess === 'controlled',
      enabledByDefault: entry.enabled
    })
    entry.tenantEnabledOverrides = await this.loadTenantEnabledOverrides(plugin.name)

    await this.reconcileActivation(entry)
  }

  async setEnabled(name: string, enabled: boolean): Promise<PluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (!entry.installed) throw new Error(`Plugin is not installed: ${name}`)
    if (entry.tenantAccess === 'controlled' && !entry.runtimeSurfaces.includes('platform')) {
      throw new Error(`Plugin is tenant-managed in workspaces: ${name}`)
    }
    if (entry.enabled === enabled) return this.toInfo(entry)

    const settings = createSettingStore(name)
    await settings.set(ENABLED_KEY, enabled ? 'true' : 'false')

    entry.enabled = enabled
    await this.reconcileActivation(entry)
    broadcastPluginsChanged()
    return this.toInfo(entry)
  }

  async install(name: string): Promise<PluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (entry.installed) return this.toInfo(entry)

    const settings = createSettingStore(name)
    await settings.set(INSTALLED_KEY, 'true')
    // Reset enabled to its persisted value. A previous uninstall left
    // _enabled untouched, but if no explicit state exists we fall back to the
    // install-wide default chosen when this policy was first initialized.
    const enabledRaw = await settings.get(ENABLED_KEY)
    entry.installed = true
    entry.enabled = enabledRaw == null
      ? isPluginEnabledByDefault(await this.getDefaultEnableMode())
      : enabledRaw !== 'false'
    await this.reconcileActivation(entry)
    broadcastPluginsChanged()
    return this.toInfo(entry)
  }

  async uninstall(name: string): Promise<PluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (!entry.installed) return this.toInfo(entry)

    if (entry.active) {
      await this.deactivate(entry)
    }
    entry.installed = false
    entry.enabled = false
    entry.active = false

    // Wipe scoped settings so a reinstall starts clean. Internal flags
    // are kept so we remember the user uninstalled this plugin.
    const prefix = `plugin:${name}:`
    const rows = await prisma.setting.findMany({ where: { key: { startsWith: prefix } } })
    const toDelete = rows
      .map((row) => row.key.slice(prefix.length))
      .filter((key) => !RESERVED_KEYS.has(key))
    if (toDelete.length > 0) {
      await prisma.setting.deleteMany({
        where: { key: { in: toDelete.map((key) => `${prefix}${key}`) } }
      })
    }
    const settings = createSettingStore(name)
    await settings.set(INSTALLED_KEY, 'false')
    broadcastPluginsChanged()
    return this.toInfo(entry)
  }

  async shutdown(): Promise<void> {
    for (const entry of this.registered.values()) {
      await this.deactivate(entry)
    }
    this.registered.clear()
  }

  list(): PluginInfo[] {
    return Array.from(this.registered.values()).map((entry) => this.toInfo(entry))
  }

  listCatalog(request: Pick<Request, 'tenant'>): PublicPluginInfo[] {
    return Array.from(this.registered.values()).map((entry) => this.toCatalogInfo(entry, request))
  }

  get(name: string): PluginInfo | null {
    const entry = this.registered.get(name)
    return entry ? this.toInfo(entry) : null
  }

  async setTenantAvailability(name: string, availability: TenantPluginAvailability): Promise<PluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (entry.tenantAccess !== 'controlled') {
      throw new Error(`Plugin does not support tenant availability controls: ${name}`)
    }

    const settings = createSettingStore(name)
    await settings.set(TENANT_DEFAULT_ALLOWED_KEY, availability.allowed ? 'true' : 'false')
    await settings.set(TENANT_DEFAULT_ENABLED_KEY, availability.enabledByDefault ? 'true' : 'false')
    await prisma.setting.deleteMany({ where: { key: { startsWith: `plugin:${name}:${LEGACY_TENANT_OVERRIDE_PREFIX}` } } })

    entry.tenantAvailability = {
      allowed: availability.allowed,
      enabledByDefault: availability.enabledByDefault
    }
    await this.reconcileActivation(entry)
    broadcastPluginsChanged()
    return this.toInfo(entry)
  }

  async setTenantEnabled(name: string, tenantId: string, enabled: boolean, request: Pick<Request, 'tenant'>): Promise<PublicPluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (entry.tenantAccess !== 'controlled' || !entry.runtimeSurfaces.includes('tenant')) {
      throw new Error(`Plugin does not support tenant workspace toggles: ${name}`)
    }
    if (!entry.tenantAvailability.allowed) {
      throw new Error(`Plugin unavailable in this workspace: ${name}`)
    }

    const currentEnabled = entry.tenantEnabledOverrides.get(tenantId) ?? entry.tenantAvailability.enabledByDefault
    if (currentEnabled === enabled) {
      return this.toCatalogInfo(entry, request)
    }

    const settings = createSettingStore(name)
    const key = `${TENANT_ENABLED_OVERRIDE_PREFIX}${tenantId}`
    if (enabled === entry.tenantAvailability.enabledByDefault) {
      entry.tenantEnabledOverrides.delete(tenantId)
      await settings.delete(key)
    } else {
      entry.tenantEnabledOverrides.set(tenantId, enabled)
      await settings.set(key, enabled ? 'true' : 'false')
    }

    await this.reconcileActivation(entry)
    broadcastPluginsChanged(tenantId)
    return this.toCatalogInfo(entry, request)
  }

  /** List `Setting` rows scoped to a plugin (excluding internal flags). */
  async listSettings(name: string): Promise<Array<{ key: string; value: string }>> {
    if (!this.registered.has(name)) return []
    const prefix = `plugin:${name}:`
    const rows = await prisma.setting.findMany({ where: { key: { startsWith: prefix } } })
    return rows
      .map((row) => ({ key: row.key.slice(prefix.length), value: row.value }))
      .filter((row) => !isReservedPluginSettingKey(row.key))
  }

  private async activate(entry: RegisteredPlugin): Promise<void> {
    const context: ApiPluginContext = {
      pluginName: entry.plugin.name,
      logger: createLogger(entry.plugin.name),
      prisma,
      printerEvents,
      ws: wsBroadcaster,
      isEnabledForTenant: (tenantId) => this.isEnabledForTenant(entry, tenantId),
      router: entry.pluginRouter,
      settings: createSettingStore(entry.plugin.name),
      onShutdown: (handler) => entry.shutdownHandlers.push(handler),
      registerPrintGuard: (guard) => {
        const wrappedGuard = ((guardContext: PrintGuardContext) => {
          const tenantId = printerManager.getTenantId(guardContext.printerId) ?? null
          if (!this.isEnabledForTenant(entry, tenantId)) {
            return true
          }
          return guard(guardContext)
        })
        const off = printGuards.register(wrappedGuard)
        entry.shutdownHandlers.push(off)
        return off
      },
      registerAuthProvider: (provider) => {
        const off = authProviderRegistry.register(provider)
        entry.shutdownHandlers.push(off)
        return off
      },
      registerSlotFilamentResolver: (resolver) => {
        // Only answer for tenants this plugin is enabled for, mirroring print guards — a
        // disabled filament plugin must not leak spool associations into other plugins.
        const scopedResolver: SlotFilamentResolver = (query) =>
          this.isEnabledForTenant(entry, query.tenantId) ? resolver(query) : Promise.resolve(null)
        const off = slotFilamentResolvers.register(scopedResolver)
        entry.shutdownHandlers.push(off)
        return off
      }
    }
    await entry.plugin.register(context)
    context.logger.info('plugin activated')
  }

  private async deactivate(entry: RegisteredPlugin): Promise<void> {
    for (const handler of entry.shutdownHandlers.reverse()) {
      try {
        await handler()
      } catch (error) {
        console.error(`[plugin:${entry.plugin.name}] shutdown failed`, error)
      }
    }
    entry.shutdownHandlers = []
    // Drop any routes the plugin registered. Express has no public API for
    // removing routes, but the sub-router is ours — clearing its stack in
    // place means subsequent requests fall through to the guard's 503.
    entry.pluginRouter.stack.length = 0
  }

  private async reconcileActivation(entry: RegisteredPlugin): Promise<void> {
    const nextActive = await this.shouldActivate(entry)
    if (nextActive === entry.active) {
      return
    }
    if (nextActive) {
      await this.activate(entry)
      entry.active = true
      return
    }
    await this.deactivate(entry)
    entry.active = false
  }

  private async shouldActivate(entry: RegisteredPlugin): Promise<boolean> {
    if (!entry.installed) {
      return false
    }
    if (entry.runtimeSurfaces.includes('platform') && entry.enabled) {
      return true
    }
    if (!entry.runtimeSurfaces.includes('tenant')) {
      return false
    }
    if (entry.tenantAccess === 'always') {
      return entry.enabled
    }
    if (entry.tenantAccess !== 'controlled' || !entry.tenantAvailability.allowed) {
      return false
    }
    return this.hasAnyEnabledTenant(entry)
  }

  private async hasAnyEnabledTenant(entry: RegisteredPlugin): Promise<boolean> {
    if (!entry.tenantAvailability.allowed) {
      return false
    }

    if (!entry.tenantAvailability.enabledByDefault) {
      return Array.from(entry.tenantEnabledOverrides.values()).some(Boolean)
    }

    const tenants = await prisma.tenant.findMany({
      select: { id: true }
    })
    if (tenants.length === 0) {
      return false
    }
    return tenants.some((tenant) => entry.tenantEnabledOverrides.get(tenant.id) ?? true)
  }

  private async getDefaultEnableMode(): Promise<PluginDefaultEnableMode> {
    if (!this.defaultEnableModePromise) {
      this.defaultEnableModePromise = (async () => {
        const existing = await prisma.setting.findUnique({ where: { key: PLUGIN_DEFAULT_ENABLE_MODE_KEY } })
        if (existing?.value === 'enabled' || existing?.value === 'disabled') {
          return existing.value
        }

        const settingCount = await prisma.setting.count()
        const mode = derivePluginDefaultEnableMode(settingCount)
        await prisma.setting.upsert({
          where: { key: PLUGIN_DEFAULT_ENABLE_MODE_KEY },
          update: { value: mode },
          create: { key: PLUGIN_DEFAULT_ENABLE_MODE_KEY, value: mode }
        })
        return mode
      })()
    }

    return this.defaultEnableModePromise
  }

  private toInfo(entry: RegisteredPlugin): PluginInfo {
    return {
      name: entry.plugin.name,
      version: entry.plugin.version,
      description: entry.plugin.description,
      source: entry.source,
      installed: entry.installed,
      enabled: entry.installed && entry.enabled,
      runtimeSurfaces: entry.runtimeSurfaces,
      managerSurfaces: entry.managerSurfaces,
      tenantAccess: entry.tenantAccess,
      availableInCurrentContext: true,
      tenantAvailability: entry.tenantAccess === 'controlled'
        ? {
            allowed: entry.tenantAvailability.allowed,
            enabledByDefault: entry.tenantAvailability.enabledByDefault
          }
        : null
    }
  }

  private toCatalogInfo(entry: RegisteredPlugin, request: Pick<Request, 'tenant'>): PublicPluginInfo {
    return {
      name: entry.plugin.name,
      version: entry.plugin.version,
      description: entry.plugin.description,
      source: entry.source,
      installed: entry.installed,
      enabled: entry.installed && this.isEnabledInRequestContext(entry, request),
      runtimeSurfaces: entry.runtimeSurfaces,
      managerSurfaces: entry.managerSurfaces,
      tenantAccess: entry.tenantAccess,
      availableInCurrentContext: this.isAvailableInRequestContext(entry, request)
    }
  }

  private isAvailableInRequestContext(entry: RegisteredPlugin, request: Pick<Request, 'tenant'>): boolean {
    const surface: PluginSurface = request.tenant ? 'tenant' : 'platform'
    if (!entry.runtimeSurfaces.includes(surface)) {
      return false
    }
    if (surface !== 'tenant') {
      return true
    }
    if (entry.tenantAccess === 'always') {
      return true
    }
    if (entry.tenantAccess === 'none') {
      return false
    }
    return entry.tenantAvailability.allowed
  }

  private isEnabledInRequestContext(entry: RegisteredPlugin, request: Pick<Request, 'tenant'>): boolean {
    const surface: PluginSurface = request.tenant ? 'tenant' : 'platform'
    if (!entry.installed) {
      return false
    }
    if (surface === 'platform') {
      return entry.enabled
    }
    if (entry.tenantAccess === 'always') {
      return entry.enabled
    }
    return this.isEnabledForTenant(entry, request.tenant?.id ?? null)
  }

  private isEnabledForTenant(entry: RegisteredPlugin, tenantId: string | null): boolean {
    if (!entry.installed || !entry.runtimeSurfaces.includes('tenant')) {
      return false
    }
    if (entry.tenantAccess === 'always') {
      return entry.enabled
    }
    if (entry.tenantAccess !== 'controlled' || !entry.tenantAvailability.allowed || !tenantId) {
      return false
    }
    return entry.tenantEnabledOverrides.get(tenantId) ?? entry.tenantAvailability.enabledByDefault
  }

  private async loadTenantAvailability(
    name: string,
    defaults: Pick<RegisteredPlugin['tenantAvailability'], 'allowed' | 'enabledByDefault'>
  ): Promise<RegisteredPlugin['tenantAvailability']> {
    const settings = createSettingStore(name)
    const allowedRaw = await settings.get(TENANT_DEFAULT_ALLOWED_KEY)
    const enabledByDefaultRaw = await settings.get(TENANT_DEFAULT_ENABLED_KEY)

    return {
      allowed: allowedRaw == null ? defaults.allowed : allowedRaw !== 'false',
      enabledByDefault: enabledByDefaultRaw == null ? defaults.enabledByDefault : enabledByDefaultRaw !== 'false'
    }
  }

  private async loadTenantEnabledOverrides(name: string): Promise<Map<string, boolean>> {
    const overridePrefix = `plugin:${name}:${TENANT_ENABLED_OVERRIDE_PREFIX}`
    const rows = await prisma.setting.findMany({
      where: { key: { startsWith: overridePrefix } },
      orderBy: { key: 'asc' }
    })

    return new Map(rows.map((row) => [row.key.slice(overridePrefix.length), row.value !== 'false'] as const))
  }

  /**
   * Remove a plugin entirely. Used when uninstalling an externally
   * installed plugin: deactivates it, drops it from the in-memory
   * registry, and clears every scoped `Setting` row including the
   * internal flags. The sub-router stack is cleared but the mount
   * itself remains (Express has no public unmount API); subsequent
   * requests fall through to the catch-all 404 handler.
   */
  async unregister(name: string): Promise<void> {
    const entry = this.registered.get(name)
    if (!entry) return
    // Tear down what is actually wired (`active`), not `enabled` — a plugin can
    // be active without being platform-`enabled` (e.g. a tenant-surface plugin),
    // and gating on `enabled` would leak its subscriptions/connections. Matches
    // `uninstall`, which also keys teardown on `active`.
    if (entry.active) {
      await this.deactivate(entry)
      entry.active = false
    }
    this.registered.delete(name)
    const prefix = `plugin:${name}:`
    await prisma.setting.deleteMany({ where: { key: { startsWith: prefix } } })
    broadcastPluginsChanged()
  }
}

function createLogger(pluginName: string): PluginLogger {
  const prefix = `[plugin:${pluginName}]`
  return {
    info: (message, meta) => console.log(prefix, message, meta ?? ''),
    warn: (message, meta) => console.warn(prefix, message, meta ?? ''),
    error: (message, meta) => console.error(prefix, message, meta ?? '')
  }
}

function createSettingStore(pluginName: string, keyPrefix?: string, broadcastTenantId?: string | null): PluginSettingStore {
  const basePrefix = keyPrefix ?? `plugin:${pluginName}:`
  const keyFor = (key: string) => `${basePrefix}${key}`
  return {
    async get(key) {
      const row = await prisma.setting.findUnique({ where: { key: keyFor(key) } })
      return row?.value ?? null
    },
    async set(key, value) {
      await prisma.setting.upsert({
        where: { key: keyFor(key) },
        create: { key: keyFor(key), value },
        update: { value }
      })
      if (!RESERVED_KEYS.has(key)) {
        broadcastPluginSettingsChanged(pluginName, broadcastTenantId)
      }
    },
    async delete(key) {
      await prisma.setting.deleteMany({ where: { key: keyFor(key) } })
      if (!RESERVED_KEYS.has(key)) {
        broadcastPluginSettingsChanged(pluginName, broadcastTenantId)
      }
    },
    forTenant(tenantId: string) {
      return createSettingStore(pluginName, `${basePrefix}tenant:${tenantId}:`, tenantId)
    }
  }
}

export const pluginRegistry = new PluginRegistry()

function normalizePluginSurfaces(input: PluginSurface[]): PluginSurface[] {
  const out = Array.from(new Set(input))
  return out.length > 0 ? out : ['tenant']
}

function defaultManagerSurfaces(runtimeSurfaces: PluginSurface[]): PluginSurface[] {
  return runtimeSurfaces.includes('tenant')
    ? ['platform', 'tenant']
    : ['platform']
}

function defaultTenantAccess(runtimeSurfaces: PluginSurface[]): PluginTenantAccess {
  return runtimeSurfaces.includes('tenant') ? 'controlled' : 'none'
}

function normalizeTenantAccess(input: PluginTenantAccess): PluginTenantAccess {
  return input
}

function validatePluginMetadata(
  pluginName: string,
  runtimeSurfaces: PluginSurface[],
  managerSurfaces: PluginSurface[],
  tenantAccess: PluginTenantAccess
): void {
  if (tenantAccess !== 'none' && !runtimeSurfaces.includes('tenant')) {
    throw new Error(`Plugin ${pluginName} sets tenantAccess=${tenantAccess} without tenant runtime support`)
  }
  if (tenantAccess === 'controlled' && !managerSurfaces.includes('platform')) {
    throw new Error(`Plugin ${pluginName} with tenantAccess=controlled must be manageable from the platform workspace`)
  }
}

function isReservedPluginSettingKey(key: string): boolean {
  return RESERVED_KEYS.has(key)
    || key.startsWith(TENANT_ENABLED_OVERRIDE_PREFIX)
    || key.startsWith(LEGACY_TENANT_OVERRIDE_PREFIX)
}
