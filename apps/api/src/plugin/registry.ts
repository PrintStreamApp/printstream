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
 *   Workspace-scoped plugins keep their own workspace-local enablement while the
 *   platform stores only the allow/default policy for workspaces.
 *
 * Background work (event listeners, timers, sockets) is torn down by
 * invoking the shutdown handlers the plugin registered, and re-created
 * by calling `register` again on enable/install.
 *
 * State is persisted under `plugin:<name>:_installed`,
 * `plugin:<name>:_enabled`, and workspace-policy keys for controlled
 * workspace plugins.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express'
import type { PluginSurface, PluginWorkspaceAccess, PluginSource, WorkspacePluginAvailability } from '@printstream/shared'
import type { ApiPlugin, ApiPluginContext, PluginInfo, PluginLogger, PluginSettingStore, PublicPluginInfo } from './types.js'
import { authProviderRegistry } from '../lib/auth-registry.js'
import type { PrintGuardContext } from '../lib/print-guards.js'
import { prisma } from '../lib/prisma.js'
import { printerEvents } from '../lib/printer-events.js'
import { printerManager } from '../lib/printer-manager.js'
import { printGuards } from '../lib/print-guards.js'
import { slotFilamentResolvers, type SlotFilamentResolver } from '../lib/slot-filament-registry.js'
import { bambuAccountResolvers, type BambuAccountResolver } from '../lib/bambu-account-registry.js'
import { wsBroadcaster } from '../lib/ws-server.js'
import { blockedPluginsForWorkspace, planGatedPluginNames } from '../lib/plugin-plan-gate.js'
import { broadcastPluginSettingsChanged, broadcastPluginsChanged } from '../lib/ws-resource-events.js'
import {
  derivePluginDefaultEnableMode,
  isPluginEnabledByDefault,
  PLUGIN_DEFAULT_ENABLE_MODE_KEY,
  PLUGIN_SETTING_PREFIX,
  type PluginDefaultEnableMode
} from './default-enable-mode.js'
import { visibleWorkspaceScope } from '../lib/workspace-visibility.js'

interface RegisteredPlugin {
  plugin: ApiPlugin
  source: PluginSource
  installed: boolean
  enabled: boolean
  /**
   * Platform-scope enablement. For plugins with their own platform bit
   * (dual-surface workspace-'controlled' plugins, whose `enabled` means the
   * workspace default) this is persisted separately under `_platformEnabled`;
   * for every other platform-capable plugin it mirrors `enabled`.
   */
  platformEnabled: boolean
  active: boolean
  runtimeSurfaces: PluginSurface[]
  managerSurfaces: PluginSurface[]
  workspaceAccess: PluginWorkspaceAccess
  workspaceAvailability: {
    allowed: boolean
    enabledByDefault: boolean
  }
  workspaceEnabledOverrides: Map<string, boolean>
  pluginRouter: Router
  shutdownHandlers: Array<() => void | Promise<void>>
}

const ENABLED_KEY = '_enabled'
const PLATFORM_ENABLED_KEY = '_platformEnabled'
const INSTALLED_KEY = '_installed'
const WORKSPACE_DEFAULT_ALLOWED_KEY = '_workspaceDefaultAllowed'
const WORKSPACE_DEFAULT_ENABLED_KEY = '_workspaceDefaultEnabled'
// Persisted settings-key prefixes; the stored spelling outlives the rename.
const WORKSPACE_ENABLED_OVERRIDE_PREFIX = '_workspaceEnabled:'
const LEGACY_WORKSPACE_OVERRIDE_PREFIX = '_workspaceAllowed:'
/** Internal keys that are never cleared on uninstall. */
const RESERVED_KEYS = new Set([ENABLED_KEY, PLATFORM_ENABLED_KEY, INSTALLED_KEY, WORKSPACE_DEFAULT_ALLOWED_KEY, WORKSPACE_DEFAULT_ENABLED_KEY])

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
    workspaceAccess?: PluginWorkspaceAccess
  } = {}): Promise<void> {
    if (this.registered.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`)
    }

    const pluginRouter = express.Router()
    const runtimeSurfaces = normalizePluginSurfaces(options.runtimeSurfaces ?? plugin.runtimeSurfaces ?? ['workspace'])
    const managerSurfaces = normalizePluginSurfaces(options.managerSurfaces ?? plugin.managerSurfaces ?? defaultManagerSurfaces(runtimeSurfaces))
    const workspaceAccess = normalizeWorkspaceAccess(options.workspaceAccess ?? plugin.workspaceAccess ?? defaultWorkspaceAccess(runtimeSurfaces))
    validatePluginMetadata(plugin.name, runtimeSurfaces, managerSurfaces, workspaceAccess)
    const entry: RegisteredPlugin = {
      plugin,
      source: options.source ?? 'builtin',
      installed: true,
      enabled: true,
      platformEnabled: true,
      active: false,
      runtimeSurfaces,
      managerSurfaces,
      workspaceAccess,
      workspaceAvailability: {
        allowed: workspaceAccess === 'controlled',
        enabledByDefault: false
      },
      workspaceEnabledOverrides: new Map(),
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
      const workspaceId = request.workspace?.id
      if (workspaceId && planGatedPluginNames().has(plugin.name)) {
        void blockedPluginsForWorkspace(workspaceId)
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
    const platformEnabledRaw = await settings.get(PLATFORM_ENABLED_KEY)
    entry.platformEnabled = options.forceEnabled ?? (platformEnabledRaw == null
      ? (hasOwnPlatformBit(entry) ? enabledByDefault : entry.enabled)
      : platformEnabledRaw !== 'false')
    entry.workspaceAvailability = await this.loadWorkspaceAvailability(plugin.name, {
      allowed: entry.workspaceAccess === 'controlled',
      enabledByDefault: entry.enabled
    })
    entry.workspaceEnabledOverrides = await this.loadWorkspaceEnabledOverrides(plugin.name)

    await this.reconcileActivation(entry)
  }

  async setEnabled(name: string, enabled: boolean): Promise<PluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (!entry.installed) throw new Error(`Plugin is not installed: ${name}`)
    if (entry.workspaceAccess === 'controlled' && !entry.runtimeSurfaces.includes('platform')) {
      throw new Error(`Plugin is workspace-managed in workspaces: ${name}`)
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
    const prefix = `${PLUGIN_SETTING_PREFIX}${name}:`
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

  listCatalog(request: Pick<Request, 'workspace'>): PublicPluginInfo[] {
    return Array.from(this.registered.values()).map((entry) => this.toCatalogInfo(entry, request))
  }

  get(name: string): PluginInfo | null {
    const entry = this.registered.get(name)
    return entry ? this.toInfo(entry) : null
  }

  async setWorkspaceAvailability(name: string, availability: WorkspacePluginAvailability): Promise<PluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (entry.workspaceAccess !== 'controlled') {
      throw new Error(`Plugin does not support workspace availability controls: ${name}`)
    }

    const settings = createSettingStore(name)
    await settings.set(WORKSPACE_DEFAULT_ALLOWED_KEY, availability.allowed ? 'true' : 'false')
    await settings.set(WORKSPACE_DEFAULT_ENABLED_KEY, availability.enabledByDefault ? 'true' : 'false')
    await prisma.setting.deleteMany({ where: { key: { startsWith: `${PLUGIN_SETTING_PREFIX}${name}:${LEGACY_WORKSPACE_OVERRIDE_PREFIX}` } } })

    entry.workspaceAvailability = {
      allowed: availability.allowed,
      enabledByDefault: availability.enabledByDefault
    }
    await this.reconcileActivation(entry)
    broadcastPluginsChanged()
    return this.toInfo(entry)
  }

  async setWorkspaceEnabled(name: string, workspaceId: string, enabled: boolean, request: Pick<Request, 'workspace'>): Promise<PublicPluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (entry.workspaceAccess !== 'controlled' || !entry.runtimeSurfaces.includes('workspace')) {
      throw new Error(`Plugin does not support workspace toggles: ${name}`)
    }
    if (!entry.workspaceAvailability.allowed) {
      throw new Error(`Plugin unavailable in this workspace: ${name}`)
    }

    const currentEnabled = entry.workspaceEnabledOverrides.get(workspaceId) ?? entry.workspaceAvailability.enabledByDefault
    if (currentEnabled === enabled) {
      return this.toCatalogInfo(entry, request)
    }

    const settings = createSettingStore(name)
    const key = `${WORKSPACE_ENABLED_OVERRIDE_PREFIX}${workspaceId}`
    if (enabled === entry.workspaceAvailability.enabledByDefault) {
      entry.workspaceEnabledOverrides.delete(workspaceId)
      await settings.delete(key)
    } else {
      entry.workspaceEnabledOverrides.set(workspaceId, enabled)
      await settings.set(key, enabled ? 'true' : 'false')
    }

    await this.reconcileActivation(entry)
    broadcastPluginsChanged(workspaceId)
    return this.toCatalogInfo(entry, request)
  }

  /** List `Setting` rows scoped to a plugin (excluding internal flags). */
  async listSettings(name: string): Promise<Array<{ key: string; value: string }>> {
    if (!this.registered.has(name)) return []
    const prefix = `${PLUGIN_SETTING_PREFIX}${name}:`
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
      // `null` asks about the PLATFORM scope: enabled there when the plugin
      // runs on the platform surface and is platform-enabled. Workspace ids keep
      // the per-workspace controlled/override semantics.
      isEnabledForWorkspace: (workspaceId) => workspaceId === null
        ? entry.installed && entry.runtimeSurfaces.includes('platform') && this.isPlatformEnabled(entry)
        : this.isEnabledForWorkspace(entry, workspaceId),
      router: entry.pluginRouter,
      settings: createSettingStore(entry.plugin.name),
      onShutdown: (handler) => entry.shutdownHandlers.push(handler),
      registerPrintGuard: (guard) => {
        const wrappedGuard = ((guardContext: PrintGuardContext) => {
          const workspaceId = printerManager.getWorkspaceId(guardContext.printerId) ?? null
          if (!this.isEnabledForWorkspace(entry, workspaceId)) {
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
        // Only answer for workspaces this plugin is enabled for, mirroring print guards — a
        // disabled filament plugin must not leak spool associations into other plugins.
        const scopedResolver: SlotFilamentResolver = (query) =>
          this.isEnabledForWorkspace(entry, query.workspaceId) ? resolver(query) : Promise.resolve(null)
        const off = slotFilamentResolvers.register(scopedResolver)
        entry.shutdownHandlers.push(off)
        return off
      },
      registerBambuAccountResolver: (resolver) => {
        // Same workspace scoping as the filament resolver, and it matters more here: the
        // credential is the user's whole Bambu account, so a connection belonging to a
        // workspace the plugin is disabled for must not be reachable through this seam.
        const scopedResolver: BambuAccountResolver = (query) =>
          this.isEnabledForWorkspace(entry, query.workspaceId) ? resolver(query) : Promise.resolve(null)
        const off = bambuAccountResolvers.register(scopedResolver)
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
    if (entry.runtimeSurfaces.includes('platform') && this.isPlatformEnabled(entry)) {
      return true
    }
    if (!entry.runtimeSurfaces.includes('workspace')) {
      return false
    }
    if (entry.workspaceAccess === 'always') {
      return entry.enabled
    }
    if (entry.workspaceAccess !== 'controlled' || !entry.workspaceAvailability.allowed) {
      return false
    }
    return this.hasAnyEnabledWorkspace(entry)
  }

  private async hasAnyEnabledWorkspace(entry: RegisteredPlugin): Promise<boolean> {
    if (!entry.workspaceAvailability.allowed) {
      return false
    }

    if (!entry.workspaceAvailability.enabledByDefault) {
      return Array.from(entry.workspaceEnabledOverrides.values()).some(Boolean)
    }

    const workspaces = await prisma.workspace.findMany({
      where: visibleWorkspaceScope,
      select: { id: true }
    })
    if (workspaces.length === 0) {
      return false
    }
    return workspaces.some((workspace) => entry.workspaceEnabledOverrides.get(workspace.id) ?? true)
  }

  private async getDefaultEnableMode(): Promise<PluginDefaultEnableMode> {
    if (!this.defaultEnableModePromise) {
      this.defaultEnableModePromise = (async () => {
        const existing = await prisma.setting.findUnique({ where: { key: PLUGIN_DEFAULT_ENABLE_MODE_KEY } })
        if (existing?.value === 'enabled' || existing?.value === 'disabled') {
          return existing.value
        }

        // Only plugin state answers "did this install predate the policy" —
        // see the reasoning in `default-enable-mode.ts`. A total row count put
        // the answer at the mercy of any other boot-time write.
        const pluginSettingCount = await prisma.setting.count({
          where: { key: { startsWith: PLUGIN_SETTING_PREFIX } }
        })
        const mode = derivePluginDefaultEnableMode(pluginSettingCount)
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
      platformEnabled: entry.runtimeSurfaces.includes('platform') ? this.isPlatformEnabled(entry) : null,
      runtimeSurfaces: entry.runtimeSurfaces,
      managerSurfaces: entry.managerSurfaces,
      workspaceAccess: entry.workspaceAccess,
      availableInCurrentContext: true,
      workspaceAvailability: entry.workspaceAccess === 'controlled'
        ? {
            allowed: entry.workspaceAvailability.allowed,
            enabledByDefault: entry.workspaceAvailability.enabledByDefault
          }
        : null
    }
  }

  private toCatalogInfo(entry: RegisteredPlugin, request: Pick<Request, 'workspace'>): PublicPluginInfo {
    return {
      name: entry.plugin.name,
      version: entry.plugin.version,
      description: entry.plugin.description,
      source: entry.source,
      installed: entry.installed,
      enabled: entry.installed && this.isEnabledInRequestContext(entry, request),
      platformEnabled: entry.runtimeSurfaces.includes('platform') ? this.isPlatformEnabled(entry) : null,
      runtimeSurfaces: entry.runtimeSurfaces,
      managerSurfaces: entry.managerSurfaces,
      workspaceAccess: entry.workspaceAccess,
      availableInCurrentContext: this.isAvailableInRequestContext(entry, request)
    }
  }

  private isAvailableInRequestContext(entry: RegisteredPlugin, request: Pick<Request, 'workspace'>): boolean {
    const surface: PluginSurface = request.workspace ? 'workspace' : 'platform'
    if (!entry.runtimeSurfaces.includes(surface)) {
      return false
    }
    if (surface !== 'workspace') {
      return true
    }
    if (entry.workspaceAccess === 'always') {
      return true
    }
    if (entry.workspaceAccess === 'none') {
      return false
    }
    return entry.workspaceAvailability.allowed
  }

  private isEnabledInRequestContext(entry: RegisteredPlugin, request: Pick<Request, 'workspace'>): boolean {
    const surface: PluginSurface = request.workspace ? 'workspace' : 'platform'
    if (!entry.installed) {
      return false
    }
    if (surface === 'platform') {
      return entry.runtimeSurfaces.includes('platform') ? this.isPlatformEnabled(entry) : entry.enabled
    }
    if (entry.workspaceAccess === 'always') {
      return entry.enabled
    }
    return this.isEnabledForWorkspace(entry, request.workspace?.id ?? null)
  }

  /** Platform-scope enablement (see `RegisteredPlugin.platformEnabled`). */
  private isPlatformEnabled(entry: RegisteredPlugin): boolean {
    if (!entry.installed || !entry.runtimeSurfaces.includes('platform')) return false
    return hasOwnPlatformBit(entry) ? entry.platformEnabled : entry.enabled
  }

  /**
   * Toggle a plugin for the platform workspace. For plugins whose `enabled`
   * flag already IS the platform switch (platform-only or workspaceAccess
   * 'always'), this delegates to `setEnabled`; dual-surface controlled
   * plugins get their own persisted bit so the workspace default stays
   * independent.
   */
  async setPlatformEnabled(name: string, enabled: boolean): Promise<PluginInfo> {
    const entry = this.registered.get(name)
    if (!entry) throw new Error(`Unknown plugin: ${name}`)
    if (!entry.installed) throw new Error(`Plugin is not installed: ${name}`)
    if (!entry.runtimeSurfaces.includes('platform')) {
      throw new Error(`Plugin does not run on the platform surface: ${name}`)
    }
    if (!hasOwnPlatformBit(entry)) {
      return await this.setEnabled(name, enabled)
    }
    if (entry.platformEnabled === enabled) return this.toInfo(entry)

    const settings = createSettingStore(name)
    await settings.set(PLATFORM_ENABLED_KEY, enabled ? 'true' : 'false')
    entry.platformEnabled = enabled
    await this.reconcileActivation(entry)
    broadcastPluginsChanged()
    return this.toInfo(entry)
  }

  private isEnabledForWorkspace(entry: RegisteredPlugin, workspaceId: string | null): boolean {
    if (!entry.installed || !entry.runtimeSurfaces.includes('workspace')) {
      return false
    }
    if (entry.workspaceAccess === 'always') {
      return entry.enabled
    }
    if (entry.workspaceAccess !== 'controlled' || !entry.workspaceAvailability.allowed || !workspaceId) {
      return false
    }
    return entry.workspaceEnabledOverrides.get(workspaceId) ?? entry.workspaceAvailability.enabledByDefault
  }

  private async loadWorkspaceAvailability(
    name: string,
    defaults: Pick<RegisteredPlugin['workspaceAvailability'], 'allowed' | 'enabledByDefault'>
  ): Promise<RegisteredPlugin['workspaceAvailability']> {
    const settings = createSettingStore(name)
    const allowedRaw = await settings.get(WORKSPACE_DEFAULT_ALLOWED_KEY)
    const enabledByDefaultRaw = await settings.get(WORKSPACE_DEFAULT_ENABLED_KEY)

    return {
      allowed: allowedRaw == null ? defaults.allowed : allowedRaw !== 'false',
      enabledByDefault: enabledByDefaultRaw == null ? defaults.enabledByDefault : enabledByDefaultRaw !== 'false'
    }
  }

  private async loadWorkspaceEnabledOverrides(name: string): Promise<Map<string, boolean>> {
    const overridePrefix = `${PLUGIN_SETTING_PREFIX}${name}:${WORKSPACE_ENABLED_OVERRIDE_PREFIX}`
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
    // be active without being platform-`enabled` (e.g. a workspace-surface plugin),
    // and gating on `enabled` would leak its subscriptions/connections. Matches
    // `uninstall`, which also keys teardown on `active`.
    if (entry.active) {
      await this.deactivate(entry)
      entry.active = false
    }
    this.registered.delete(name)
    const prefix = `${PLUGIN_SETTING_PREFIX}${name}:`
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

function createSettingStore(pluginName: string, keyPrefix?: string, broadcastWorkspaceId?: string | null): PluginSettingStore {
  const basePrefix = keyPrefix ?? `${PLUGIN_SETTING_PREFIX}${pluginName}:`
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
        broadcastPluginSettingsChanged(pluginName, broadcastWorkspaceId)
      }
    },
    async delete(key) {
      await prisma.setting.deleteMany({ where: { key: keyFor(key) } })
      if (!RESERVED_KEYS.has(key)) {
        broadcastPluginSettingsChanged(pluginName, broadcastWorkspaceId)
      }
    },
    forWorkspace(workspaceId: string) {
      return createSettingStore(pluginName, `${basePrefix}workspace:${workspaceId}:`, workspaceId)
    }
  }
}

export const pluginRegistry = new PluginRegistry()

/**
 * Whether the plugin keeps a dedicated platform-enable bit: dual-surface
 * workspace-'controlled' plugins, where `enabled` means "enabled by default for
 * workspaces" and cannot double as the platform switch.
 */
function hasOwnPlatformBit(entry: Pick<RegisteredPlugin, 'runtimeSurfaces' | 'workspaceAccess'>): boolean {
  return entry.runtimeSurfaces.includes('platform')
    && entry.runtimeSurfaces.includes('workspace')
    && entry.workspaceAccess === 'controlled'
}

function normalizePluginSurfaces(input: PluginSurface[]): PluginSurface[] {
  const out = Array.from(new Set(input))
  return out.length > 0 ? out : ['workspace']
}

function defaultManagerSurfaces(runtimeSurfaces: PluginSurface[]): PluginSurface[] {
  return runtimeSurfaces.includes('workspace')
    ? ['platform', 'workspace']
    : ['platform']
}

function defaultWorkspaceAccess(runtimeSurfaces: PluginSurface[]): PluginWorkspaceAccess {
  return runtimeSurfaces.includes('workspace') ? 'controlled' : 'none'
}

function normalizeWorkspaceAccess(input: PluginWorkspaceAccess): PluginWorkspaceAccess {
  return input
}

function validatePluginMetadata(
  pluginName: string,
  runtimeSurfaces: PluginSurface[],
  managerSurfaces: PluginSurface[],
  workspaceAccess: PluginWorkspaceAccess
): void {
  if (workspaceAccess !== 'none' && !runtimeSurfaces.includes('workspace')) {
    throw new Error(`Plugin ${pluginName} sets workspaceAccess=${workspaceAccess} without workspace runtime support`)
  }
  if (workspaceAccess === 'controlled' && !managerSurfaces.includes('platform')) {
    throw new Error(`Plugin ${pluginName} with workspaceAccess=controlled must be manageable from the platform workspace`)
  }
}

function isReservedPluginSettingKey(key: string): boolean {
  return RESERVED_KEYS.has(key)
    || key.startsWith(WORKSPACE_ENABLED_OVERRIDE_PREFIX)
    || key.startsWith(LEGACY_WORKSPACE_OVERRIDE_PREFIX)
}
