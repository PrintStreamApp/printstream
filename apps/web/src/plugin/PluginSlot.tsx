/**
 * Render every component plugins have registered for a named slot.
 * Core pages use this to expose extension points without depending on
 * any specific plugin.
 *
 * When a host needs to know whether a slot has contributors before it renders (to
 * change its own markup, not just to fill a hole), use `usePluginSlots` directly.
 */
import { Fragment, type ReactNode } from 'react'
import { usePluginSlots } from './usePluginSlots'

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
  const slots = usePluginSlots(name)
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
