/**
 * Seeds the editor's project-local MACHINE overrides from the file it opened.
 *
 * Without this the override map starts empty on every open, which makes the whole feature
 * write-only: the "changed vs preset" badge reads zero for a project that genuinely carries machine
 * deltas, the printer-settings dialog opens on the bare preset, and the next "Apply to this
 * project" therefore emits a diff that DROPS whatever the file already had. The process side has
 * always re-hydrated its baked deltas (`useProcessProfileSelection`); this is the machine twin.
 *
 * Seeding is not an edit: it writes the map directly rather than through the settings-edit
 * listener, so opening a project that carries overrides does not mark it dirty or push an undo
 * frame. It never overwrites a map the user has already touched this session either, so a
 * mid-session preset switch cannot wipe an in-flight edit.
 *
 * "Once per (file, preset)" is the intent, but the guard latches on an ANSWER rather than on an
 * attempt -- see {@link machineOverrideSeedDecision}, where the difference is the whole correctness
 * of the hook. The identity includes the file VERSION, because a save rewrites the project's machine
 * block without changing the file id.
 *
 * Counterpart: `POST /api/slicing/profiles/resolve-machine` with `sourceFileId`, whose reading half
 * is `readMachineSettingOverrides` in `@printstream/shared` -- next to the writer that produced the
 * record, since the two disagreeing is invisible from either side.
 */
import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { resolveWorkspaceMachineConfig } from '../workspaceMachineResolver'

/**
 * What to do with an answer from the resolve route. Pure, and split out because the ordering here
 * is the whole correctness of the hook and it got it wrong: latching the once-per-key guard on an
 * answer that seeded NOTHING burns the single seed attempt on React Query's cached `{}` from before
 * the save, so the fresh answer that arrives a moment later is refused and the user's saved override
 * never appears. Reported twice as "still not showing my change after saving then opening".
 *
 * - `wait`   nothing to act on YET: no answer, already seeded, or an empty answer that a later
 *            refetch may still fill in. Deliberately does NOT latch.
 * - `settle` there is an answer but the user has already edited this session, so their map wins.
 *            Latches, because re-deciding could only ever clobber them.
 * - `seed`   adopt the file's overrides. Latches.
 */
export function machineOverrideSeedDecision(input: {
  overrides: Record<string, string | string[]> | undefined
  seededKey: string | null
  key: string
  hasCurrentEdits: boolean
}): 'wait' | 'settle' | 'seed' {
  if (!input.overrides) return 'wait'
  if (input.seededKey === input.key) return 'wait'
  if (input.hasCurrentEdits) return 'settle'
  if (Object.keys(input.overrides).length === 0) return 'wait'
  return 'seed'
}

export function useProjectMachineOverrides(input: {
  /** Null outside a library-backed host (the public editor reads its own archive). */
  sourceFileId: string | null
  machineProfileId: string
  slicerTargetId: string
  /**
   * Changes whenever the file does. Part of the query key because a SAVE rewrites the project's
   * machine block without changing the file id, so keying on the id alone served the pre-save
   * answer back from cache and the override read as absent on reopen.
   */
  fileVersion: string
  /** Live map, so seeding can stand down once the user has authored anything. */
  current: Record<string, string | string[]>
  onSeed: (overrides: Record<string, string | string[]>) => void
  /**
   * Called once the server has stated what this file records, INCLUDING when it records nothing.
   * Separate from {@link onSeed}, which only fires when there is something to adopt: the save needs
   * to know the difference between "the file overrides nothing" and "we never found out", because
   * only the first may be acted on.
   */
  onKnown?: () => void
}): boolean {
  const enabled = Boolean(input.sourceFileId) && input.machineProfileId.length > 0 && input.slicerTargetId.length > 0
  const query = useQuery({
    queryKey: ['project-machine-overrides', input.sourceFileId, input.fileVersion, input.machineProfileId, input.slicerTargetId],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => await resolveWorkspaceMachineConfig({
      machineProfileId: input.machineProfileId,
      targetId: input.slicerTargetId || null,
      sourceFileId: input.sourceFileId,
      sourceFileUploadedAt: input.fileVersion
    }, { signal })
  })

  // Keyed on the same identity as the query, so one answer seeds at most once even across
  // re-renders, and a genuinely different file or preset can seed again.
  const seededKey = useRef<string | null>(null)
  const key = `${input.sourceFileId ?? ''}|${input.fileVersion}|${input.machineProfileId}|${input.slicerTargetId}`
  // Null is the server saying it could not read the file; treat it as no answer at all rather than
  // as an empty set, or the save downstream reads it as "this project overrides nothing".
  const overrides = query.data?.projectOverrides ?? undefined
  const hasCurrent = Object.keys(input.current).length > 0
  const onSeed = input.onSeed
  const onKnown = input.onKnown
  useEffect(() => {
    if (overrides) onKnown?.()
  }, [overrides, onKnown])
  useEffect(() => {
    const decision = machineOverrideSeedDecision({ overrides, seededKey: seededKey.current, key, hasCurrentEdits: hasCurrent })
    if (decision === 'wait') return
    seededKey.current = key
    if (decision === 'seed') onSeed(overrides!)
    // `hasCurrent` is read at decision time on purpose: it flips the moment we seed, and depending
    // on it would re-enter with a stale key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, key, onSeed])

  // Whether the file's own machine deltas are KNOWN for the version currently open. False while the
  // query is in flight, when it failed, and for a host with no file to read.
  return Boolean(overrides)
}
