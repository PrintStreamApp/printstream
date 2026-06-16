/**
 * Render web-plugin slots without consulting API plugin state.
 *
 * This is reserved for auth/setup surfaces that must remain available before
 * an authenticated plugin-manager session exists.
 */
import { Fragment } from 'react'
import React from 'react'
import { webPluginRegistry } from './registry'

export function StaticPluginSlot({
  name,
  context
}: {
  name: string
  context?: Record<string, unknown>
}) {
  const slots = webPluginRegistry.slots(name)
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