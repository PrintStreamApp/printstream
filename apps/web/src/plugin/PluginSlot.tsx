/**
 * Render every component plugins have registered for a named slot.
 * Core pages use this to expose extension points without depending on
 * any specific plugin.
 */
import { useMemo } from 'react'
import { Fragment, type ReactNode } from 'react'
import type { PluginSurface } from '@printstream/shared'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { usePluginCatalogQuery } from '../lib/pluginCatalogQuery'
import { isPluginActiveByName, pluginSupportsRuntimeSurface } from '../lib/pluginSettings'
import { webPluginRegistry } from './registry'

interface PluginSlotProps {
  name: string
  /** Props forwarded to every plugin slot component. */
  context?: Record<string, unknown>
  /**
   * Core default rendered when no active plugin contributes to this slot. It is also forwarded to
   * each contribution as a `fallback` prop, so a single-owner "override" slot (one plugin replacing
   * a core fragment) can render the core default itself when it has nothing to contribute for the
   * current context — e.g. an AMS slot with no linked spool. Leave unset (default `null`) for
   * append-only extension points.
   */
  fallback?: ReactNode
}

export function PluginSlot({ name, context, fallback = null }: PluginSlotProps) {
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
  if (slots.length === 0) return <>{fallback}</>
  return (
    <>
      {slots.map((slot, index) => {
        const Component = slot.component
        return (
          <Fragment key={`${name}:${index}`}>
            <Component {...(context ?? {})} fallback={fallback} />
          </Fragment>
        )
      })}
    </>
  )
}
