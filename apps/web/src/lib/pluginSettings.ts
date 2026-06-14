import type { PluginCatalogEntry, PluginManagementEntry, PluginSurface } from '@printstream/shared'
import type { WebPlugin } from '../plugin/types'

export type ApiPluginInfo = PluginCatalogEntry | PluginManagementEntry

export interface MergedPluginEntry {
  name: string
  version?: string
  description?: string
  api: ApiPluginInfo | null
  web: WebPlugin | null
}

export type PluginSettingsSurface = 'notifications' | 'manager'

export interface PluginStateSnapshot {
  scopeKey: string
  plugins: ReadonlyArray<ApiPluginInfo>
}

export function isNotificationPlugin(name: string): boolean {
  return name.startsWith('notifications-')
}

export function isAuthPlugin(name: string): boolean {
  return name.startsWith('auth-')
}

export function mergePlugins(api: ApiPluginInfo[], web: WebPlugin[]): MergedPluginEntry[] {
  const byName = new Map<string, MergedPluginEntry>()
  for (const plugin of api) {
    byName.set(plugin.name, {
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      api: plugin,
      web: null
    })
  }
  for (const plugin of web) {
    const existing = byName.get(plugin.name)
    if (existing) {
      existing.web = plugin
      existing.version ??= plugin.version
      existing.description ??= plugin.description
    } else {
      byName.set(plugin.name, {
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        api: null,
        web: plugin
      })
    }
  }
  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name))
}

export function isPluginInstalled(entry: MergedPluginEntry): boolean {
  return entry.api ? entry.api.installed : true
}

export function isPluginEnabled(entry: MergedPluginEntry): boolean {
  return entry.api ? entry.api.enabled : true
}

export function isPluginAvailableInCurrentContext(entry: MergedPluginEntry): boolean {
  return entry.api ? entry.api.availableInCurrentContext : true
}

export function isPluginActiveByName(
  pluginName: string,
  apiPluginsByName: ReadonlyMap<string, ApiPluginInfo>,
  hasPluginState: boolean
): boolean {
  if (!hasPluginState) return false
  const plugin = apiPluginsByName.get(pluginName)
  return plugin ? plugin.availableInCurrentContext && plugin.installed && plugin.enabled : true
}

export function getNewlyDisabledPluginNames(
  previous: ReadonlyArray<ApiPluginInfo>,
  next: ReadonlyArray<ApiPluginInfo>
): string[] {
  const previousByName = new Map(previous.map((plugin) => [plugin.name, plugin] as const))
  return next.flatMap((plugin) => {
    const prior = previousByName.get(plugin.name)
    if (!prior?.availableInCurrentContext || !prior.installed || !prior.enabled) return []
    if (!plugin.availableInCurrentContext || !plugin.installed || plugin.enabled) return []
    return [plugin.name]
  })
}

export function getNewlyDisabledPluginNamesForSnapshot(
  previous: PluginStateSnapshot | null,
  next: PluginStateSnapshot
): string[] {
  if (!previous || previous.scopeKey !== next.scopeKey) return []
  return getNewlyDisabledPluginNames(previous.plugins, next.plugins)
}

export function extractDisabledPluginNameFromErrorMessage(message: string): string | null {
  const match = /^Plugin disabled:\s*(.+?)\s*$/.exec(message.trim())
  return match?.[1] ?? null
}

export function extractUnavailablePluginNameFromErrorMessage(message: string): string | null {
  const normalized = message.trim()
  const disabled = extractDisabledPluginNameFromErrorMessage(normalized)
  if (disabled) return disabled
  const notInstalled = /^Plugin not installed:\s*(.+?)\s*$/.exec(normalized)
  return notInstalled?.[1] ?? null
}

export function shouldRenderPluginSettingsPanel(entry: MergedPluginEntry, surface: PluginSettingsSurface): boolean {
  if (!entry.web?.settingsPanel) return false
  if (isAuthPlugin(entry.name)) return false
  if (!isPluginInstalled(entry) || !isPluginEnabled(entry) || !isPluginAvailableInCurrentContext(entry)) return false
  return surface === 'notifications'
    ? isNotificationPlugin(entry.name)
    : !isNotificationPlugin(entry.name)
}

export function pluginHasManagerSurface(
  entry: Pick<MergedPluginEntry, 'api' | 'web'>,
  surface: PluginSurface
): boolean {
  return resolveManagerSurfaces(entry).includes(surface)
}

export function pluginSupportsRuntimeSurface(
  entry: Pick<MergedPluginEntry, 'api' | 'web'> | { runtimeSurfaces: PluginSurface[] },
  surface: PluginSurface
): boolean {
  if ('runtimeSurfaces' in entry) {
    return entry.runtimeSurfaces.includes(surface)
  }
  return resolveRuntimeSurfaces(entry).includes(surface)
}

export function compareNotificationPluginEntries(left: MergedPluginEntry, right: MergedPluginEntry): number {
  const leftPriority = notificationPluginPriority(left.name)
  const rightPriority = notificationPluginPriority(right.name)
  if (leftPriority !== rightPriority) return leftPriority - rightPriority
  return left.name.localeCompare(right.name)
}

export function getPluginDisplayName(name: string): string {
  switch (name) {
    case 'notifications-browser':
      return 'Browser Push Notifications'
    case 'notifications-discord':
      return 'Discord Notifications'
    case 'notifications-ntfy':
      return 'ntfy Notifications'
    case 'firmware-updates':
      return 'Firmware Updates'
    case 'home-assistant':
      return 'Home Assistant'
    default:
      return name
        .split('-')
        .filter(Boolean)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ')
    }
}

function notificationPluginPriority(name: string): number {
  if (name === 'notifications-browser') return 0
  if (name === 'notifications-discord') return 1
  if (name === 'notifications-ntfy') return 2
  return 10
}

function resolveRuntimeSurfaces(entry: Pick<MergedPluginEntry, 'api' | 'web'>): PluginSurface[] {
  return entry.api?.runtimeSurfaces ?? entry.web?.runtimeSurfaces ?? ['tenant']
}

function resolveManagerSurfaces(entry: Pick<MergedPluginEntry, 'api' | 'web'>): PluginSurface[] {
  return entry.api?.managerSurfaces ?? entry.web?.managerSurfaces ?? ['platform', 'tenant']
}
