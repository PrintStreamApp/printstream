/**
 * Plugin registry for the web client.
 *
 * Synchronous, in-memory, and intentionally tiny. Plugins register
 * themselves at module load (see `builtin.ts`); the App component
 * reads the registry at render time to mount routes and slots.
 *
 * No reactivity: plugins are static for the lifetime of the page. If a
 * future iteration needs runtime install/uninstall, that can be layered
 * on by exposing a subscribe API here.
 */
import type { PluginSurface } from '@printstream/shared'
import type { WebPlugin, WebPluginRoute, WebPluginSlot } from './types'

export type RegisteredWebPluginSlot = WebPluginSlot & {
  pluginName: string
  runtimeSurfaces: PluginSurface[]
  managerSurfaces: PluginSurface[]
}

class WebPluginRegistry {
  private readonly plugins = new Map<string, WebPlugin>()

  register(plugin: WebPlugin): void {
    if (this.plugins.has(plugin.name)) {
      console.warn(`Web plugin already registered: ${plugin.name}`)
      return
    }
    this.plugins.set(plugin.name, plugin)
  }

  list(): WebPlugin[] {
    return Array.from(this.plugins.values())
  }

  routes(): Array<WebPluginRoute & { pluginName: string; runtimeSurfaces: PluginSurface[]; managerSurfaces: PluginSurface[] }> {
    const out: Array<WebPluginRoute & { pluginName: string; runtimeSurfaces: PluginSurface[]; managerSurfaces: PluginSurface[] }> = []
    for (const plugin of this.plugins.values()) {
      const runtimeSurfaces = normalizePluginSurfaces(plugin.runtimeSurfaces)
      const managerSurfaces = normalizeManagerSurfaces(plugin.managerSurfaces, runtimeSurfaces)
      for (const route of plugin.routes ?? []) {
        out.push({ ...route, pluginName: plugin.name, runtimeSurfaces, managerSurfaces })
      }
    }
    return out
  }

  slots(name: string): RegisteredWebPluginSlot[] {
    const out: RegisteredWebPluginSlot[] = []
    for (const plugin of this.plugins.values()) {
      const runtimeSurfaces = normalizePluginSurfaces(plugin.runtimeSurfaces)
      const managerSurfaces = normalizeManagerSurfaces(plugin.managerSurfaces, runtimeSurfaces)
      for (const slot of plugin.slots ?? []) {
        if (slot.name === name) out.push({ ...slot, pluginName: plugin.name, runtimeSurfaces, managerSurfaces })
      }
    }
    return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  /**
   * Run every registered plugin's `init` hook. Call once after all
   * built-in plugins have been registered. Errors thrown by one
   * plugin are logged and do not block the others.
   */
  runInitHooks(): void {
    for (const plugin of this.plugins.values()) {
      if (!plugin.init) continue
      try {
        plugin.init()
      } catch (error) {
        console.error(`[plugin:${plugin.name}] init failed`, error)
      }
    }
  }
}

export const webPluginRegistry = new WebPluginRegistry()

function normalizePluginSurfaces(input: PluginSurface[] | undefined): PluginSurface[] {
  return input && input.length > 0 ? Array.from(new Set(input)) : ['tenant']
}

function normalizeManagerSurfaces(input: PluginSurface[] | undefined, runtimeSurfaces: PluginSurface[]): PluginSurface[] {
  if (input && input.length > 0) {
    return Array.from(new Set(input))
  }
  return runtimeSurfaces.includes('tenant') ? ['platform', 'tenant'] : ['platform']
}
