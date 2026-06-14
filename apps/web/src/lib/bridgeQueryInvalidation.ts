import type { QueryClient } from '@tanstack/react-query'

type QueryInvalidator = Pick<QueryClient, 'invalidateQueries'>

export async function invalidateBridgeQueries(queryClient: QueryInvalidator): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
    queryClient.invalidateQueries({ queryKey: ['bridges'] }),
    queryClient.invalidateQueries({ queryKey: ['settings-bridges'] }),
    queryClient.invalidateQueries({ queryKey: ['library-browse'] })
  ])
}