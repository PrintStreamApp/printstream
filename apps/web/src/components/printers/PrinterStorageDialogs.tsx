/**
 * The three printer SD-storage browsers reachable from the card's actions menu — general files,
 * sliced models, and timelapses — each a {@link PrinterStorageModal} preset. Grouped out of
 * PrinterCard so the card's render tree isn't cluttered with three near-identical modal configs.
 */
import type { Printer } from '@printstream/shared'
import { PrinterStorageModal } from '../../components/PrinterStorageModal'

export interface PrinterStorageDialogsProps {
  printer: Printer
  canDispatchPrints: boolean
  canManagePrinter: boolean
  canDownloadPrinterStorage: boolean
  demoMode: boolean
  storageOpen: boolean
  modelsOpen: boolean
  timelapsesOpen: boolean
  onCloseStorage: () => void
  onCloseModels: () => void
  onCloseTimelapses: () => void
}

export function PrinterStorageDialogs({
  printer,
  canDispatchPrints,
  canManagePrinter,
  canDownloadPrinterStorage,
  demoMode,
  storageOpen,
  modelsOpen,
  timelapsesOpen,
  onCloseStorage,
  onCloseModels,
  onCloseTimelapses
}: PrinterStorageDialogsProps) {
  return (
    <>
      {storageOpen && (
        <PrinterStorageModal
          printerId={printer.id}
          printerName={printer.name}
          printerModel={printer.model}
          allowPrint={canDispatchPrints}
          allowUpload={canManagePrinter && !demoMode}
          allowDownload={canDownloadPrinterStorage}
          allowManage={canManagePrinter}
          onClose={onCloseStorage}
        />
      )}
      {modelsOpen && (
        <PrinterStorageModal
          printerId={printer.id}
          printerName={printer.name}
          printerModel={printer.model}
          title={`Models on ${printer.name}`}
          description="Sliced 3MF/G-code files stored on the printer. Tap a file to print it."
          acceptExtensions={/\.(3mf|gcode)$/i}
          previewKind="model"
          flat
          allowPrint={canDispatchPrints}
          allowDownload={canDownloadPrinterStorage}
          allowManage={canManagePrinter}
          allowUpload={false}
          onClose={onCloseModels}
        />
      )}
      {timelapsesOpen && (
        <PrinterStorageModal
          printerId={printer.id}
          printerName={printer.name}
          printerModel={printer.model}
          title={`Timelapses on ${printer.name}`}
          description="Recorded timelapses on the printer's SD card."
          initialPath="/timelapse"
          acceptExtensions={/\.mp4$/i}
          previewKind="timelapse"
          flat
          allowPrint={false}
          allowDownload={canDownloadPrinterStorage}
          allowManage={canManagePrinter}
          allowUpload={false}
          onClose={onCloseTimelapses}
        />
      )}
    </>
  )
}
