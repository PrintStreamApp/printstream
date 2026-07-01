/**
 * Plugin contract for the web client.
 *
 * Web plugins extend the UI by registering routes, dashboard widgets,
 * settings panels, and named extension points (slots) that core pages
 * can render into.
 *
 * Plugins must remain optional: removing a plugin must never break a
 * core page. Plugins should never assume any other plugin is installed.
 *
 * Built-in plugins live under `apps/web/src/plugins/<name>/` and are wired up
 * in `apps/web/src/plugin/builtin.ts`. A route with a `navLabel` becomes a
 * top-level tab (tab icons are assigned in `App.tsx`). Third-party plugins
 * should ship as ordinary npm packages whose default export is a `WebPlugin`;
 * a runtime loader can be added later without changing existing plugins.
 */
import type { ComponentType, ReactNode } from 'react'
import type { PluginSurface } from '@printstream/shared'

export interface WebPluginRoute {
  path: string
  element: ComponentType
  /** Optional nav label. If omitted, the route is reachable but unlisted. */
  navLabel?: string
  /**
   * Optional mobile bottom-nav icon for this route's tab. When omitted the
   * shell falls back to a generic plugin icon. Supply a custom icon so the tab
   * reads at a glance on phones.
   */
  navMobileIcon?: ReactNode
}

export interface WebPluginSlotComponentProps {
  /** Free-form context the host page passes to the slot, keyed per slot. */
  [key: string]: unknown
}

export interface WebPluginSlot {
  /** Slot name. Core pages render `<PluginSlot name="..." />`. */
  name: string
  /** Component rendered into the slot. Receives whatever props the slot host passes. */
  component: ComponentType<WebPluginSlotComponentProps>
  /** Optional ordering hint when multiple plugins target the same slot. */
  order?: number
}

export interface WebPlugin {
  name: string
  version?: string
  /** Short user-facing description shown in the plugin manager. */
  description?: string
  runtimeSurfaces?: PluginSurface[]
  managerSurfaces?: PluginSurface[]
  /**
   * When true, the plugin is only relevant to self-hosted deployments and is
   * hidden from the plugin manager in cloud mode. Mirrors the API's
   * `isSelfHostedDeployment()` registration gate for the backend, which the web
   * can only evaluate at runtime via `runtimePolicy.selfHosted`.
   */
  selfHostedOnly?: boolean
  routes?: WebPluginRoute[]
  slots?: WebPluginSlot[]
  /**
   * Optional settings panel rendered inside the plugin manager when the
   * user expands the plugin. Use this for plugins that need their own
   * configuration UI (e.g. notification topic, API key).
   */
  settingsPanel?: ComponentType
  /**
   * Optional one-shot init hook, invoked once after the registry has
   * collected every plugin and before the React tree mounts. Useful
   * for plugins that need to attach long-lived listeners outside the
   * component tree (e.g. WebSocket subscribers, service workers).
   *
   * May return a teardown function. Teardown is currently only
   * invoked if a future runtime install/uninstall flow needs it; for
   * built-ins, init runs once for the lifetime of the page.
   */
  init?: () => void | (() => void)
}
