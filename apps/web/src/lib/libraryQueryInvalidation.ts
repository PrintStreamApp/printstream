import type { QueryClient } from '@tanstack/react-query'

type QueryInvalidator = Pick<QueryClient, 'invalidateQueries'>

/**
 * Refresh the library browser/list slices (grid, folders, plates, recycle bin). Does NOT
 * touch the 3D editor's per-file scene caches — use this for background/broadcast-driven
 * refreshes (a WS `resource.changed: library` from any library mutation, anywhere) so an
 * open editor isn't yanked out from under the user: refetching its scene rebuilds the 3D
 * view, and the editor is showing an immutable version snapshot that didn't change.
 */
export async function invalidateLibraryListQueries(queryClient: QueryInvalidator): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['library-browse'] })
  await queryClient.invalidateQueries({ queryKey: ['library-files'] })
  await queryClient.invalidateQueries({ queryKey: ['library-folders'] })
  await queryClient.invalidateQueries({ queryKey: ['library-plates'] })
  await queryClient.invalidateQueries({ queryKey: ['library-recycle-bin'] })
}

export async function invalidateLibraryQueries(queryClient: QueryInvalidator): Promise<void> {
  await invalidateLibraryListQueries(queryClient)
  // Deliberately does NOT refresh the editor's own scene/plate caches any more.
  //
  // It used to, "so the editor reflects its OWN save without a manual page reload". That stopped
  // being merely unnecessary and became WRONG once the editor started reading the project from an
  // archive it downloads once per session: the refetch re-reads that in-memory PRE-save archive
  // and stores the result as fresh, so the cache ends up holding stale data with a new timestamp,
  // and the next editor session inherits it. Measured directly — toggling printability, saving,
  // then reopening in the same page showed the pre-save value while the file, the API and the
  // reopen's own download were all correct.
  //
  // The session does not need the refresh: it authored the save and its state is authoritative
  // (see the "in-memory after open" contract). `EditorView` drops these keys when it unmounts so
  // no LATER session can inherit this one's view of the file.
  // The slice panel's pre-open "changed vs preset" badges resolve a project preset's embedded
  // config keyed by FILE ID — which a save does not change (it mints a new version under the same
  // id). Without an explicit bust, a save that rewrites project_settings (material change, the
  // stale-array heal) keeps serving the pre-save count until staleTime, while the tune dialog
  // (which fetches on every open) already shows the truth — a badge-vs-dialog mismatch.
  await queryClient.invalidateQueries({ queryKey: ['process-baked-changes'] })
  await queryClient.invalidateQueries({ queryKey: ['filament-baked-changes'] })
  // Same class, and the one with teeth: the project preset's resolved config (the baked deltas the
  // slice dialog carries onto a new preset when the machine changes) is keyed by file id and held
  // at `staleTime: Infinity`, so a save that rewrote project_settings left it wrong for the rest of
  // the page session — and those deltas reach a SLICE, unlike a badge count.
  await queryClient.invalidateQueries({ queryKey: ['slice-project-process-carry'] })
  // Single-file metadata DTOs (name, version counter, repair flags). Refreshing them never
  // redraws a scene, and NOT refreshing them is how the editor's repair banner stayed up after a
  // successful repair: the banner gates on `['library-file', id]`, which nothing here touched, so
  // it kept rendering the pre-repair flags and the repair read as having done nothing.
  await queryClient.invalidateQueries({ queryKey: ['library-file'] })
}