import type { QueryClient } from '@tanstack/react-query'

type QueryInvalidator = Pick<QueryClient, 'invalidateQueries'>

export async function invalidateLibraryQueries(queryClient: QueryInvalidator): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['library-browse'] })
  await queryClient.invalidateQueries({ queryKey: ['library-files'] })
  await queryClient.invalidateQueries({ queryKey: ['library-folders'] })
  await queryClient.invalidateQueries({ queryKey: ['library-plates'] })
  await queryClient.invalidateQueries({ queryKey: ['library-recycle-bin'] })
}