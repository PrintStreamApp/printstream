/**
 * Printer management writes for PrintersView.
 *
 * `PrinterManagementDialogs` owns dialogs; `PrintersView` owns permission checks.
 * This hook owns HTTP writes and the query refreshes they require, including
 * stats after a printer edit.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Printer } from '@printstream/shared'
import type { PrinterFormValues } from '../components/printers/PrinterFormModal'
import { apiFetch } from '../lib/apiClient'
import { toast } from '../lib/toast'

type Options = {
  closeAddDialog: () => void
  closeEditDialog: () => void
  closeSortDialog: () => void
}

/** Omit a blank write-only access code so an edit preserves the printer's code. */
function printerEditBody(input: PrinterFormValues) {
  const { accessCode, ...rest } = input
  return accessCode.trim() ? input : rest
}

/** Expose printer writes while keeping dialog visibility with the caller. */
export function usePrinterManagementMutations({ closeAddDialog, closeEditDialog, closeSortDialog }: Options) {
  const queryClient = useQueryClient()

  const add = useMutation({
    mutationFn: (input: PrinterFormValues) =>
      apiFetch<{ printer: Printer }>('/api/printers', { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printers'] })
      closeAddDialog()
    }
  })

  const edit = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PrinterFormValues }) =>
      apiFetch<{ printer: Printer }>(`/api/printers/${id}`, {
        method: 'PATCH',
        body: printerEditBody(input)
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printers'] })
      // Manual lifetime-stats adjustments are part of printer settings.
      void queryClient.invalidateQueries({ queryKey: ['printer-stats'] })
      closeEditDialog()
    }
  })

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/printers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printers'] })
      closeEditDialog()
    }
  })

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch('/api/printers/reorder', { method: 'POST', body: { orderedIds } }),
    onSuccess: () => {
      toast.success('Printer order saved')
      void queryClient.invalidateQueries({ queryKey: ['printers'] })
      closeSortDialog()
    }
  })

  return { add, edit, remove, reorder }
}
