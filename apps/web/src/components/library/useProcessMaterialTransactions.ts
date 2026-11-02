/**
 * Material topology changes must resolve the selected process before remapping its positional
 * references. Both controller hosts use this boundary, including AMS sync. History and scene
 * changes run only after resolution succeeds and the originating editor state is still current.
 */
import { useEffect, useRef, useState } from 'react'
import type { ProcessConfigResolver, ProcessConfigRequest } from '../ProcessSettingsDialog'
import type { SliceSettingsController } from './SliceSettingsPanel'

type MaterialActions = Pick<SliceSettingsController, 'onRemoveFilament' | 'onReorderFilament' | 'onSyncFilaments'>

/** Wrap synchronous slot actions; stale or failed preparation changes neither materials nor history. */
export function useProcessMaterialTransactions(input: {
  resolve: ProcessConfigResolver
  request: ProcessConfigRequest
  /** Includes the material list and process edits so a pending gesture cannot replay after undo. */
  scope: unknown
  actions: MaterialActions
}): MaterialActions & { materialChangeError: string | null } {
  const [materialChangeError, setError] = useState<string | null>(null)
  const scope = JSON.stringify([input.request, input.scope])
  const latest = useRef({ scope, resolve: input.resolve })
  latest.current = { scope, resolve: input.resolve }
  const generation = useRef(0)
  useEffect(() => {
    ++generation.current
    // This is a request counter, not a DOM ref. Cleanup invalidates the latest pending request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { ++generation.current }
  }, [scope, input.resolve])

  const run = async (commit: () => void) => {
    const token = ++generation.current
    const isCurrent = () => generation.current === token
      && latest.current.scope === scope && latest.current.resolve === input.resolve
    setError(null)
    try {
      if (input.request.processProfileId && !input.resolve.peekSource?.(input.request.processProfileId)) {
        // Capture the source before any position changes. A range check after the move cannot
        // distinguish an in-range reference to the wrong material.
        await (input.resolve.resolveSource ?? input.resolve)(input.request)
      }
      if (isCurrent()) commit()
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : 'Could not load process settings before changing materials.')
    }
  }

  return {
    materialChangeError,
    onRemoveFilament: (id, replacement, beforeCommit) => {
      void run(() => {
        beforeCommit?.()
        input.actions.onRemoveFilament(id, replacement)
      })
    },
    onReorderFilament: (from, insertAt, beforeCommit) => {
      void run(() => {
        beforeCommit?.()
        input.actions.onReorderFilament(from, insertAt)
      })
    },
    onSyncFilaments: (choices, beforeCommit) => {
      void run(() => {
        beforeCommit?.()
        input.actions.onSyncFilaments(choices)
      })
    }
  }
}
