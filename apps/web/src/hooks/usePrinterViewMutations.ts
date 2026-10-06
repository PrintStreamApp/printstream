/**
 * Saved printer-view writes and cache reconciliation for PrintersView.
 *
 * The caller owns route selection and dialog visibility. This hook keeps the
 * normal form mutations and quiet inline PATCH on the same workspace-scoped
 * query key, so an inline edit cannot leave the dialog's view list stale.
 */
import { useCallback } from 'react'
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { type PrinterView, type PrinterViewInput, extractErrorMessage } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { printerViewInputWithContent, type PrinterViewContent } from '../lib/printerViewDraft'
import { toast } from '../lib/toast'

type Options = {
  queryKey: QueryKey
  closeDialog: () => void
  onCreated: (id: string) => void
  onDeleted: (id: string) => void
  clearDraft: () => void
}

type ViewResponse = { view: PrinterView }
type ViewList = { views: PrinterView[] }
type UpdateInput = { id: string; input: PrinterViewInput }

/** Maintain the saved-view cache while exposing form and inline mutations. */
export function usePrinterViewMutations({ queryKey, closeDialog, onCreated, onDeleted, clearDraft }: Options) {
  const queryClient = useQueryClient()

  const create = useMutation({
    mutationFn: (input: PrinterViewInput) =>
      apiFetch<ViewResponse>('/api/printer-views', { method: 'POST', body: input }),
    onSuccess: ({ view }) => {
      toast.success('View saved')
      queryClient.setQueryData<ViewList>(queryKey, (current) => ({
        views: [...(current?.views ?? []), view]
      }))
      void queryClient.invalidateQueries({ queryKey })
      clearDraft()
      closeDialog()
      // The new address renders directly once its view is seeded in the cache.
      onCreated(view.id)
    }
  })

  const update = useMutation({
    mutationFn: ({ id, input }: UpdateInput) =>
      apiFetch<ViewResponse>(`/api/printer-views/${id}`, { method: 'PATCH', body: input }),
    onSuccess: ({ view }) => {
      toast.success('View updated')
      queryClient.setQueryData<ViewList>(queryKey, (current) => ({
        views: (current?.views ?? []).map((entry) => (entry.id === view.id ? view : entry))
      }))
      void queryClient.invalidateQueries({ queryKey })
      closeDialog()
    }
  })

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/printer-views/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      toast.success('View deleted')
      queryClient.setQueryData<ViewList>(queryKey, (current) => ({
        views: (current?.views ?? []).filter((entry) => entry.id !== id)
      }))
      void queryClient.invalidateQueries({ queryKey })
      // The API clears a workspace default naming this view. Its settings
      // cache and the caller's device override must follow that deletion.
      onDeleted(id)
      void queryClient.invalidateQueries({ queryKey: ['general-settings'] })
      closeDialog()
    }
  })

  // Inline toolbar saves already render optimistically and should not show a
  // second toast or close a dialog. On failure, refetch the server's truth.
  const quietUpdate = useMutation({
    mutationFn: ({ id, input }: UpdateInput) =>
      apiFetch<ViewResponse>(`/api/printer-views/${id}`, { method: 'PATCH', body: input }),
    onSuccess: ({ view }) => {
      queryClient.setQueryData<ViewList>(queryKey, (current) => ({
        views: (current?.views ?? []).map((entry) => (entry.id === view.id ? view : entry))
      }))
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error))
      void queryClient.invalidateQueries({ queryKey })
    }
  })

  const mutateQuietly = quietUpdate.mutate

  /** Commit toolbar edits immediately in the cache while the server PATCH is in flight. */
  const saveToolbarContent = useCallback((view: PrinterView, content: PrinterViewContent) => {
    const input = printerViewInputWithContent(view, content)
    queryClient.setQueryData<ViewList>(queryKey, (current) => ({
      views: (current?.views ?? []).map((entry) => (entry.id === view.id ? { ...entry, ...input } : entry))
    }))
    mutateQuietly({ id: view.id, input })
    clearDraft()
    toast.success('View updated')
  }, [clearDraft, mutateQuietly, queryClient, queryKey])

  return { create, update, remove, saveToolbarContent }
}
