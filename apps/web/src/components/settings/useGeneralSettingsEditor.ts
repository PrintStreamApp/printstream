/**
 * Shared plumbing for cards that edit a workspace-wide general setting: the
 * `['general-settings']` React Query cache App.tsx owns, the `/api/settings`
 * save mutation (which writes the response back so app-wide consumers stay in
 * sync), and the manage-settings capability that gates the shared tier.
 *
 * Extracted from the three self-contained two-tier cards
 * (`EditorViewportSettingsCards`, `SlicerDeveloperModeCard`,
 * `DefaultPrinterViewCard`) so the cache-key/mutation shape cannot drift
 * between them.
 */
import { extractErrorMessage, type GeneralSettings, type UpdateGeneralSettingsInput } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'

export function useGeneralSettingsEditor() {
  const queryClient = useQueryClient()
  const canManageSettings = useAuthBootstrapQuery().data?.capabilities?.canManageSettings ?? false
  const query = useQuery({
    queryKey: ['general-settings'],
    queryFn: ({ signal }) => apiFetch<GeneralSettings>('/api/settings', { signal })
  })
  const mutation = useMutation({
    mutationFn: (input: UpdateGeneralSettingsInput) =>
      apiFetch<GeneralSettings>('/api/settings', { method: 'PUT', body: input }),
    onSuccess: (data) => {
      // Keep the app-wide general-settings cache authoritative, matching App.tsx.
      queryClient.setQueryData(['general-settings'], data)
    }
  })
  return {
    canManageSettings,
    settings: query.data,
    save: mutation,
    saveError: mutation.error ? extractErrorMessage(mutation.error) : null
  }
}
