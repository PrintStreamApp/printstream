/**
 * Own the saved-view settings and deletion dialogs for the printer directory.
 * PrintersView retains route selection, staged toolbar drafts, and mutation
 * lifecycle; this component keeps dialog state and delete confirmation together.
 */
import { useState } from 'react'
import type { PrinterView, PrinterViewInput } from '@printstream/shared'
import type { usePrinterViewMutations } from '../../hooks/usePrinterViewMutations'
import { savedViewDialogState } from '../../lib/printerViewDialogState'
import { OVERVIEW_VIEW_LABEL } from '../../lib/printersViewHelpers'
import { ConfirmActionDialog } from '../ConfirmActionDialog'
import { PrinterViewsModal } from './PrinterViewModals'

type Mutations = Pick<ReturnType<typeof usePrinterViewMutations>, 'create' | 'update' | 'remove'>

type Props = {
  open: boolean
  mode: 'settings' | 'create'
  activeView: PrinterView | null
  displayedState: PrinterViewInput
  views: PrinterView[]
  mutations: Mutations
  onClose: () => void
  onApplyDefault: (input: PrinterViewInput) => void
}

/** Keep deletion confirmation mounted when the settings form closes. */
export function PrinterSavedViewDialogs({
  open,
  mode,
  activeView,
  displayedState,
  views,
  mutations,
  onClose,
  onApplyDefault
}: Props) {
  const [deleteTarget, setDeleteTarget] = useState<PrinterView | null>(null)
  const { create, update, remove } = mutations
  const error = create.error ?? update.error ?? remove.error
  const submitting = create.isPending || update.isPending || remove.isPending

  return (
    <>
      {open && (
        <PrinterViewsModal
          mode={mode}
          activeView={activeView}
          currentViewLabel={mode === 'create' ? 'New view' : activeView?.name ?? OVERVIEW_VIEW_LABEL}
          currentState={savedViewDialogState(mode, activeView, displayedState)}
          submitting={submitting}
          error={error instanceof Error ? error.message : null}
          onClose={onClose}
          onApplyDefault={onApplyDefault}
          onCreate={(input) => create.mutate(input)}
          onUpdate={(id, input) => update.mutate({ id, input })}
          onDelete={(id) => setDeleteTarget(views.find((entry) => entry.id === id) ?? null)}
        />
      )}

      <ConfirmActionDialog
        open={deleteTarget != null}
        title="Delete saved view?"
        description={deleteTarget ? `Delete the saved printer view "${deleteTarget.name}"? This only removes the saved layout and filters.` : ''}
        confirmLabel="Delete view"
        pending={remove.isPending && remove.variables === deleteTarget?.id}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return
          remove.mutate(deleteTarget.id, { onSettled: () => setDeleteTarget(null) })
        }}
      />
    </>
  )
}
