/**
 * The effective process config a project's objects inherit from, resolved once for a surface that
 * needs to READ it rather than edit it.
 *
 * `ProcessSettingsDialog` resolves the same thing for its own value space, but it cannot be borrowed
 * for a read: resolving is only the first of the things it does with the answer, and the rest
 * (explicit/mixed key seeding, field-state computation, the edit buffer) only make sense for one
 * target at a time. The parameter table needs the resolved config for every row at once and edits
 * none of them.
 *
 * It deliberately returns `response.config` (the profile WITH its own overrides applied) run through
 * `applyProcessConfigDefaults`, not `response.baseConfig`. Two reasons, and getting either wrong
 * shows the user a value nothing will print at: `config` is what an object actually inherits, which
 * is the same baseline the per-object dialog composes; and without the defaults pass a key the
 * preset does not mention reads as unset rather than as its default, which is most of the catalog.
 *
 * Failure is a NULL config, never a thrown error: the surface using this must stay useful without
 * it (an overridden cell resolves from the override alone), so a preset that will not resolve
 * degrades the table rather than replacing it with an error.
 */
import { useEffect, useState } from 'react'
import { applyProcessConfigDefaults, type ProcessConfig } from '@printstream/shared'
import { resolveWorkspaceProcessConfig } from '../../../components/workspaceProcessResolver'
import type { ProcessConfigResolver } from '../../../components/ProcessSettingsDialog'

export interface ResolvedProcessConfigInput {
  /** Resolution is skipped entirely while false, so a closed dialog costs nothing. */
  enabled: boolean
  slicerTargetId: string
  processProfileId: string
  sourceFileId: string | null
  /**
   * The host's resolver. Omitted, the workspace route is used (see the dialog's own seam).
   *
   * **Must be a STABLE reference** -- it is in this hook's effect dependency array, so an inline
   * resolver re-fires the request on every render of the caller, and in the editor that means every
   * live printer-status update. `ProcessSettingsDialog` carries the same requirement on the same
   * prop; hosts memoize it (`useLocalSliceSettingsController`'s `resolveProcessConfig`).
   */
  resolveConfig?: ProcessConfigResolver
}

export interface ResolvedProcessConfigState {
  config: ProcessConfig | null
  loading: boolean
  /** Set when resolution failed. The caller may show it, but must still render without a config. */
  error: string | null
}

export function useResolvedProcessConfig(input: ResolvedProcessConfigInput): ResolvedProcessConfigState {
  const { enabled, slicerTargetId, processProfileId, sourceFileId, resolveConfig } = input
  const [config, setConfig] = useState<ProcessConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !processProfileId) {
      setConfig(null)
      setError(null)
      // Clear `loading` too. It was left set, so disabling the hook (or losing the profile) while a
      // resolve was in flight parked it at `{ config: null, loading: true }` forever: the cleanup
      // below sets `cancelled` first, which makes the in-flight `.finally` skip its own reset. The
      // current caller ignores `loading`, so it was latent -- but this is a shared read-side seam
      // and the next consumer to render a spinner from it would hang.
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    // Every dependency is a primitive EXCEPT `resolveConfig`, which is a function and therefore the
    // one that can re-fire this on a caller's re-render -- see its doc above. Do not add an object
    // dependency (the resolver's request object, say): that is the recurring bug in load effects
    // here, and it re-fetches on every render rather than when the request actually changes.
    ;(resolveConfig ?? resolveWorkspaceProcessConfig)({
      processProfileId,
      targetId: slicerTargetId || null,
      sourceFileId: sourceFileId || null
    })
      .then((response) => {
        if (cancelled) return
        setConfig(applyProcessConfigDefaults(response.config))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setConfig(null)
        setError(err instanceof Error ? err.message : 'Failed to load process settings')
        // Also logged, not only surfaced: the caller renders this as "inherited values are
        // unavailable", which tells the user what they lost but not why, and the preset id and
        // target are what any diagnosis starts from. Safe identifiers only.
        console.warn('[parameterTable] could not resolve the process preset', {
          processProfileId,
          slicerTargetId,
          error: err instanceof Error ? err.message : String(err)
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [enabled, processProfileId, slicerTargetId, sourceFileId, resolveConfig])

  return { config, loading, error }
}
