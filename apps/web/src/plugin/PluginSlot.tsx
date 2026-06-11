/**
 * Render every component plugins have registered for a named slot.
 * Core pages use this to expose extension points without depending on
 * any specific plugin.
 */
import { useMemo } from 'react'
import { Fragment } from 'react'
import type { PluginSurface } from '@printstream/shared'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { usePluginCatalogQuery } from '../lib/pluginCatalogQuery'
import { isPluginActiveByName, pluginSupportsRuntimeSurface } from '../lib/pluginSettings'
import { webPluginRegistry } from './registry'

interface PluginSlotProps {
  name: string
  /** Props forwarded to every plugin slot component. */
  context?: Record<string, unknown>
}

export function PluginSlot({ name, context }: PluginSlotProps) {
  const authBootstrapQuery = useAuthBootstrapQuery()
  const pluginStateQuery = usePluginCatalogQuery({
    enabled: authBootstrapQuery.isSuccess ? (!authBootstrapQuery.data.authEnabled || authBootstrapQuery.data.actor.type !== 'anonymous') : false,
    suppressGlobalErrorToast: true
  })
  const currentSurface: PluginSurface = authBootstrapQuery.data?.tenant ? 'tenant' : 'platform'
  const apiPluginsByName = useMemo(
    () => new Map((pluginStateQuery.data?.plugins ?? []).map((plugin) => [plugin.name, plugin] as const)),
    [pluginStateQuery.data?.plugins]
  )
  const slots = useMemo(
    () => webPluginRegistry
      .slots(name)
      .filter((slot) => pluginSupportsRuntimeSurface(slot, currentSurface))
      .filter((slot) => isPluginActiveByName(slot.pluginName, apiPluginsByName, pluginStateQuery.data?.plugins != null)),
    [apiPluginsByName, currentSurface, name, pluginStateQuery.data?.plugins]
  )
  if (slots.length === 0) return null
  return (
    <>
      {slots.map((slot, index) => {
        const Component = slot.component
        return (
          <Fragment key={`${name}:${index}`}>
            <Component {...(context ?? {})} />
          </Fragment>
        )
      })}
    </>
  )
}
