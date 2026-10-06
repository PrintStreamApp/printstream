/**
 * Add, edit, remove, and reorder printer dialogs.
 * The parent owns visibility and selection; this component keeps each write and
 * its pending/error state beside the dialog that presents it.
 */
import type { BridgeListResponse, DiscoveredPrinter, Printer, PrinterStatus } from '@printstream/shared'
import { usePromptDialog } from '../PromptDialogProvider'
import { usePrinterManagementMutations } from '../../hooks/usePrinterManagementMutations'
import { showDemoPrinterMutationNotice } from '../../lib/printerViewConstants'
import { PrinterFormModal } from './PrinterFormModal'
import { PrinterSortModal } from './PrinterViewModals'

type Props = {
  addOpen: boolean
  editing: Printer | null
  sortOpen: boolean
  printers: Printer[]
  statuses: Record<string, PrinterStatus> | undefined
  bridges: BridgeListResponse['bridges']
  discovered: DiscoveredPrinter[]
  demoMode: boolean
  onCloseAdd: () => void
  onCloseEdit: () => void
  onCloseSort: () => void
}

/** Keep printer-management writes mounted while routes and dialogs change. */
export function PrinterManagementDialogs({
  addOpen,
  editing,
  sortOpen,
  printers,
  statuses,
  bridges,
  discovered,
  demoMode,
  onCloseAdd,
  onCloseEdit,
  onCloseSort
}: Props) {
  const { confirm } = usePromptDialog()
  const {
    add: addPrinter,
    edit: editPrinter,
    remove: deletePrinter,
    reorder: reorderPrinters
  } = usePrinterManagementMutations({
    closeAddDialog: onCloseAdd,
    closeEditDialog: onCloseEdit,
    closeSortDialog: onCloseSort
  })

  return (
    <>
      {addOpen && (
        <PrinterFormModal
          mode="add"
          demoMode={demoMode}
          submitting={addPrinter.isPending}
          error={addPrinter.error ? (addPrinter.error as Error).message : null}
          bridges={bridges}
          discovered={discovered}
          onCancel={onCloseAdd}
          onSubmit={(input) => {
            if (demoMode) {
              showDemoPrinterMutationNotice('add')
              return
            }
            addPrinter.mutate(input)
          }}
        />
      )}

      {editing && (
        <PrinterFormModal
          mode="edit"
          demoMode={demoMode}
          printerId={editing.id}
          initialValues={{
            ...editing,
            bridgeId: editing.bridgeId ?? ''
          }}
          status={statuses?.[editing.id]}
          bridges={bridges}
          submitting={editPrinter.isPending}
          deleting={deletePrinter.isPending}
          error={
            editPrinter.error
              ? (editPrinter.error as Error).message
              : deletePrinter.error
                ? (deletePrinter.error as Error).message
                : null
          }
          onCancel={onCloseEdit}
          onSubmit={(input) => {
            if (demoMode) {
              showDemoPrinterMutationNotice('edit')
              return
            }
            editPrinter.mutate({ id: editing.id, input })
          }}
          onDelete={async () => {
            const confirmed = await confirm({
              title: `Remove ${editing.name}?`,
              description: `Remove ${editing.name}? This will disconnect the printer.`,
              confirmLabel: 'Remove printer',
              color: 'danger'
            })
            if (!confirmed) return
            if (demoMode) {
              showDemoPrinterMutationNotice('delete')
              return
            }
            deletePrinter.mutate(editing.id)
          }}
        />
      )}

      {sortOpen && (
        <PrinterSortModal
          printers={printers}
          submitting={reorderPrinters.isPending}
          error={reorderPrinters.error ? (reorderPrinters.error as Error).message : null}
          onCancel={onCloseSort}
          onSubmit={(orderedIds) => reorderPrinters.mutate(orderedIds)}
        />
      )}
    </>
  )
}
