/**
 * Stacked library, local-file, slice, and print dialogs for the printer dashboard.
 * The page owns target selection through `usePrinterPrintFlow`; keep earlier
 * pickers mounted beneath a later step so Back restores the user's selection.
 */
import { useQueryClient } from '@tanstack/react-query'
import type { Printer, SlicingCapabilities } from '@printstream/shared'
import type { usePrinterPrintFlow } from '../../hooks/usePrinterPrintFlow'
import { usePrinterSliceJob } from '../../hooks/usePrinterSliceJob'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { isUnslicedThreeMfFile } from '../../lib/libraryFileTags'
import { showDemoFileUploadNotice } from '../../lib/printerViewConstants'
import { SliceFileModal } from '../library/SliceFileModal'
import { SliceThenPrintFlow } from '../library/SliceThenPrintFlow'
import { SliceThenPrintModal } from '../library/SliceThenPrintModal'
import { PrintModal } from '../library/PrintModal'
import { PrinterPickerDialog } from '../PrinterPickerDialog'
import { LocalFilePrintGate } from './PrinterFormModal'
import { LibraryPickerModal } from './LibraryPickerModal'

type Props = {
  flow: ReturnType<typeof usePrinterPrintFlow>
  printers: Printer[]
  capabilities: SlicingCapabilities | null
  capabilitiesLoading: boolean
  capabilitiesError: string | null
  canUploadLibrary: boolean
  canDispatchPrints: boolean
  demoMode: boolean
}

/** Render every print-flow step while the hook controls which targets are active. */
export function PrinterPrintFlowDialogs({
  flow,
  printers,
  capabilities,
  capabilitiesLoading,
  capabilitiesError,
  canUploadLibrary,
  canDispatchPrints,
  demoMode
}: Props) {
  const queryClient = useQueryClient()
  const {
    pickerForPrinter, setPickerForPrinter,
    printTarget, setPrintTarget,
    sliceTarget, setSliceTarget,
    sliceThenPrintTarget, setSliceThenPrintTarget,
    resliceJob, setResliceJob,
    localFileForPrinter, setLocalFileForPrinter,
    pageLibraryPickerOpen, setPageLibraryPickerOpen,
    pageLocalPrinterPickerOpen, setPageLocalPrinterPickerOpen,
    closePrintFlow, goBackFromPrintFlow
  } = flow
  const startSlicingJob = usePrinterSliceJob(setSliceThenPrintTarget)

  return (
    <>
      {pickerForPrinter && (
        <LibraryPickerModal
          printerName={pickerForPrinter.name}
          canSlice={canUploadLibrary}
          onClose={() => setPickerForPrinter(null)}
          onPick={(file) => {
            // Keep the picker mounted underneath so "Back" from the slice/print setup
            // returns to file selection (matching the sliced-file branch below).
            if (isUnslicedThreeMfFile(file)) {
              setSliceTarget({ file, preferredPrinterId: pickerForPrinter.id })
              return
            }
            setPrintTarget({ file, printerId: pickerForPrinter.id })
          }}
        />
      )}

      {printTarget && (
        <PrintModal
          file={printTarget.file}
          printers={printers}
          defaultPrinterId={printTarget.printerId}
          lockPrinterSelection={Boolean(printTarget.printerId)}
          defaultPlate={printTarget.defaultPlate}
          defaultPrintOptions={printTarget.defaultPrintOptions}
          defaultAmsMapping={printTarget.defaultAmsMapping}
          submitPrint={printTarget.submitPrint}
          onSubmitted={() => {
            void queryClient.invalidateQueries({ queryKey: ['jobs'] })
          }}
          onClose={closePrintFlow}
          onBack={pickerForPrinter || pageLibraryPickerOpen ? goBackFromPrintFlow : undefined}
        />
      )}

      {pageLocalPrinterPickerOpen && (
        <PrinterPickerDialog
          open
          title="Choose a printer for the local file"
          entries={printers.map((printer) => ({
            printer,
            disabledReason: printer.bridgeId ? undefined : 'Assign this printer to a bridge first.'
          }))}
          selectedPrinterId={null}
          onClose={() => setPageLocalPrinterPickerOpen(false)}
          onSelect={(printer) => {
            if (!printer) return
            if (demoMode) showDemoFileUploadNotice()
            setLocalFileForPrinter(printer)
          }}
        />
      )}

      {localFileForPrinter && (
        <LocalFilePrintGate
          demoMode={demoMode}
          printer={localFileForPrinter}
          onCancel={() => setLocalFileForPrinter(null)}
          onUploaded={(file) => {
            setPrintTarget({ file, printerId: localFileForPrinter.id })
            setLocalFileForPrinter(null)
          }}
        />
      )}

      {pageLibraryPickerOpen && (
        <LibraryPickerModal
          canSlice={canUploadLibrary}
          onClose={() => setPageLibraryPickerOpen(false)}
          onPick={(file) => {
            // Keep the picker mounted underneath so "Back" from the slice/print setup
            // returns to file selection (matching the sliced-file branch below).
            if (isUnslicedThreeMfFile(file)) {
              setSliceTarget({ file, preferredPrinterId: '' })
              return
            }
            setPrintTarget({ file, printerId: '' })
          }}
        />
      )}

      {sliceTarget && (
        <SliceFileModal
          // Re-mount per file: the dialog's per-file state (materials, one-shot default
          // seeding) must not survive a target swap. See LibraryView's mount.
          key={sliceTarget.file.id}
          file={sliceTarget.file}
          printers={printers}
          capabilities={capabilities}
          capabilitiesLoading={capabilitiesLoading}
          capabilitiesError={capabilitiesError}
          submitting={startSlicingJob.isPending}
          submitAction={startSlicingJob.variables?.action ?? null}
          submitError={startSlicingJob.error instanceof Error ? startSlicingJob.error.message : null}
          flow="print"
          preferredPrinterId={sliceTarget.preferredPrinterId || undefined}
          // Back returns to the still-open library picker; Cancel abandons the whole flow.
          onBack={() => setSliceTarget(null)}
          onClose={closePrintFlow}
          onSubmit={(input, action) => startSlicingJob.mutate({
            file: sliceTarget.file,
            preferredPrinterId: sliceTarget.preferredPrinterId,
            action,
            ...input
          })}
        />
      )}

      {canUploadLibrary && canDispatchPrints && resliceJob?.sourceProjectFileId && (
        <SliceThenPrintFlow
          fileId={resliceJob.sourceProjectFileId}
          printers={printers}
          preferredPrinterId={resliceJob.printerId}
          defaultPlate={resliceJob.plate ?? 1}
          initialSlicerTargetId={resliceJob.sliceSettings?.slicerTargetId}
          flowCopy={{
            title: `Slice ${formatLibraryFileName(resliceJob.sourceProjectFileName ?? resliceJob.jobName)} again`,
            description: 'These are the settings this print was sliced with. Change anything you like, then continue to printer selection.'
          }}
          onClose={() => setResliceJob(null)}
        />
      )}

      {sliceThenPrintTarget && (
        <SliceThenPrintModal
          sourceFile={sliceThenPrintTarget.sourceFile}
          jobId={sliceThenPrintTarget.jobId}
          preferredPrinterId={sliceThenPrintTarget.preferredPrinterId || undefined}
          lockPrinterSelection={Boolean(sliceThenPrintTarget.preferredPrinterId)}
          printers={printers}
          // Back returns to the still-open slice settings; Cancel abandons the whole flow.
          onBack={() => setSliceThenPrintTarget(null)}
          onClose={closePrintFlow}
        />
      )}
    </>
  )
}
