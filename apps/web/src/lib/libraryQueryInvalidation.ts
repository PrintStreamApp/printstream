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
  // The 3D editor caches a file's parsed scene + plates under separate keys; refresh those too
  // so the editor reflects its OWN save/restore/retarget without a manual page reload. Only
  // call this for a deliberate local mutation — not for background broadcasts (see above).
  await queryClient.invalidateQueries({ queryKey: ['library-editor-plates'] })
  await queryClient.invalidateQueries({ queryKey: ['library-editor-scene-initial'] })
  await queryClient.invalidateQueries({ queryKey: ['library-editor-scenes-rest'] })
}