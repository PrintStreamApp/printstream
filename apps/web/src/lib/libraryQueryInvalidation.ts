import type { QueryClient } from '@tanstack/react-query'

type QueryInvalidator = Pick<QueryClient, 'invalidateQueries'>

export async function invalidateLibraryQueries(queryClient: QueryInvalidator): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['library-browse'] })
  await queryClient.invalidateQueries({ queryKey: ['library-files'] })
  await queryClient.invalidateQueries({ queryKey: ['library-folders'] })
  await queryClient.invalidateQueries({ queryKey: ['library-plates'] })
  await queryClient.invalidateQueries({ queryKey: ['library-recycle-bin'] })
  // The 3D editor caches a file's parsed scene + plates under separate keys; refresh those too
  // so a restore/save/retarget is reflected without a manual page reload.
  await queryClient.invalidateQueries({ queryKey: ['library-editor-plates'] })
  await queryClient.invalidateQueries({ queryKey: ['library-editor-scene-initial'] })
  await queryClient.invalidateQueries({ queryKey: ['library-editor-scenes-rest'] })
}