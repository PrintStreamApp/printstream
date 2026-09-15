/**
 * The active plugin contributions for a named slot, after surface and
 * enabled-state filtering.
 *
 * Its own module (rather than living next to `<PluginSlot />`) because a host
 * sometimes has to know whether a slot has contributors BEFORE it renders, a
 * toolbar that becomes a split button only when its menu has entries cannot learn
 * that from a component whose whole job is to render nothing in that case.
 *
 * Prefer `<PluginSlot />` when you only need to render the contributions; reach for
 * this when the answer changes the surrounding markup.
 */
import { useMemo } from 'react'
import type { PluginSurface } from '@printstream/shared'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { usePluginCatalogQuery } from '../lib/pluginCatalogQuery'
import {
  activePluginSlots
} from '../lib/pluginSettings'
import { webPluginRegistry } from './registry'
import { useRuntimePolicy } from '../lib/runtimePolicy'

export function usePluginSlots(name: string) {
  const { selfHosted } = useRuntimePolicy()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const pluginStateQuery = usePluginCatalogQuery({
    enabled: authBootstrapQuery.isSuccess ? (!authBootstrapQuery.data.authEnabled || authBootstrapQuery.data.actor.type !== 'anonymous') : false,
    suppressGlobalErrorToast: true
  })
  const currentSurface: PluginSurface = authBootstrapQuery.data?.workspace ? 'workspace' : 'platform'
  const apiPluginsByName = useMemo(
    () => new Map((pluginStateQuery.data?.plugins ?? []).map((plugin) => [plugin.name, plugin] as const)),
    [pluginStateQuery.data?.plugins]
  )
  return useMemo(
    () => activePluginSlots(webPluginRegistry.slots(name), {
      selfHosted,
      actorType: authBootstrapQuery.data?.actor.type,
      currentSurface,
      apiPluginsByName,
      hasPluginState: pluginStateQuery.data?.plugins != null
    }),
    [apiPluginsByName, authBootstrapQuery.data?.actor.type, currentSurface, name, pluginStateQuery.data?.plugins, selfHosted]
  )
}
