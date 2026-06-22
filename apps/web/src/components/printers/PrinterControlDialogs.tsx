/**
 * The control/configuration dialogs for a printer card: calibration, the multi-tab controls panel
 * (temperatures, fans, movement, …), and printer settings. Calibration and controls are
 * control-gated; settings is management-gated. All fire {@link PrinterCommand}s through a single
 * `onCommand`. Grouped out of PrinterCard to keep its render tree focused.
 */
import type {
  getPrinterCalibrationCapabilities,
  getPrinterControlCapabilities,
  Printer,
  PrinterCommand,
  PrinterStatus
} from '@printstream/shared'
import { PrinterControlsDialog } from './PrinterControlsDialog'
import { CalibrationModal, PrinterSettingsDialog } from './PrinterCardDialogs'
import type { PrinterControlsDialogTab } from '../../lib/printerViewTypes'

export interface PrinterControlDialogsProps {
  printer: Printer
  status: PrinterStatus | undefined
  canControlPrinter: boolean
  canManagePrinter: boolean
  submitting: boolean
  onCommand: (command: PrinterCommand) => void
  calibrationOpen: boolean
  calibrationCapabilities: ReturnType<typeof getPrinterCalibrationCapabilities>
  onCloseCalibration: () => void
  controlsOpen: boolean
  controlCapabilities: ReturnType<typeof getPrinterControlCapabilities>
  controlsInitialTab: PrinterControlsDialogTab
  onCloseControls: () => void
  printerSettingsOpen: boolean
  onClosePrinterSettings: () => void
}

export function PrinterControlDialogs({
  printer,
  status,
  canControlPrinter,
  canManagePrinter,
  submitting,
  onCommand,
  calibrationOpen,
  calibrationCapabilities,
  onCloseCalibration,
  controlsOpen,
  controlCapabilities,
  controlsInitialTab,
  onCloseControls,
  printerSettingsOpen,
  onClosePrinterSettings
}: PrinterControlDialogsProps) {
  return (
    <>
      {canControlPrinter && calibrationOpen && (
        <CalibrationModal
          capabilities={calibrationCapabilities}
          printerName={printer.name}
          submitting={submitting}
          onClose={onCloseCalibration}
          onSubmit={(command) => onCommand(command)}
        />
      )}
      {canControlPrinter && controlsOpen && status && (
        <PrinterControlsDialog
          printer={printer}
          status={status}
          capabilities={controlCapabilities}
          initialTab={controlsInitialTab}
          submitting={submitting}
          onClose={onCloseControls}
          onSubmit={(command) => onCommand(command)}
        />
      )}
      {canManagePrinter && printerSettingsOpen && status && (
        <PrinterSettingsDialog
          printerModel={printer.model}
          printerName={printer.name}
          ductMode={status.ductMode}
          ductAvailableModes={status.ductAvailableModes}
          settings={status.printOptions}
          submitting={submitting}
          onClose={onClosePrinterSettings}
          onSubmit={(command) => onCommand(command)}
        />
      )}
    </>
  )
}
