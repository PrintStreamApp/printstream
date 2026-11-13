/**
 * A counter that moves whenever any slicing preset this tab can slice with may have changed.
 *
 * Why it exists: the two "reuse the previous slice" checks (`preparedSliceStageCache.ts` in the
 * editor, `browserSliceResultCache.ts` in the library) compare the slice REQUEST, and a request
 * names presets by id. Updating a custom preset in place keeps its id, so after "Update preset"
 * the next Slice compared equal and reopened the result sliced with the OLD preset. Both checks
 * include this revision, so any preset write makes the next slice run again.
 *
 * Moved by: the server's `slicing.profiles` resource event (every custom preset create, overwrite
 * and delete, in any tab, plus Bambu Cloud sync), each in-tab preset write as it succeeds (so a
 * Slice clicked before that event arrives is still fresh), and the browser-only local preset store.
 * It is deliberately coarse: an unrelated preset change costs one re-slice, never a stale result.
 *
 * Module state, scoped to the tab: identities are compared only within one page lifetime.
 */
let revision = 0

/** The current revision, to record beside a reusable slice's identity. */
export function currentSlicingPresetRevision(): number {
  return revision
}

/** Record that a preset may have changed. */
export function bumpSlicingPresetRevision(): void {
  revision += 1
}
