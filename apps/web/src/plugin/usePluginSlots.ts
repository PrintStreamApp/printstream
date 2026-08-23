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
import { isPluginActiveByName, pluginSupportsRuntimeSurface } from '../lib/pluginSettings'
import { webPluginRegistry } from './registry'

export function usePluginSlots(name: string) {
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
    () => webPluginRegistry
      .slots(name)
      .filter((slot) => pluginSupportsRuntimeSurface(slot, currentSurface))
      .filter((slot) => isPluginActiveByName(slot.pluginName, apiPluginsByName, pluginStateQuery.data?.plugins != null)),
    [apiPluginsByName, currentSurface, name, pluginStateQuery.data?.plugins]
  )
}
