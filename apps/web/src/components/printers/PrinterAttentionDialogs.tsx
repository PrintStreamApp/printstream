/**
 * The two "needs attention" dialogs for a printer card: the assistant (surfaces the printer's
 * current attention reason and quick recovery actions) and the filament-recovery loader. They are
 * linked — the assistant's "load filament" action hands off to the recovery dialog. Grouped out of
 * PrinterCard so the handoff wiring lives in one place.
 */
import type { Printer, PrinterCommand, PrinterStatus } from '@printstream/shared'
import { FilamentRecoveryDialog, PrinterAssistantDialog } from './PrinterCardDialogs'
import type { PrinterRecoveryFilamentSource } from '../../lib/printerViewTypes'

export interface PrinterAttentionDialogsProps {
  printer: Printer
  status: PrinterStatus | undefined
  submitting: boolean
  onCommand: (command: PrinterCommand) => void
  filamentRecoveryOpen: boolean
  filamentRecoverySources: PrinterRecoveryFilamentSource[]
  onCloseFilamentRecovery: () => void
  /** Open the filament-recovery dialog (the assistant's "load filament" handoff target). */
  onOpenFilamentRecovery: () => void
  assistantOpen: boolean
  assistantCanOpenLiveView: boolean
  assistantCanLoadFilament: boolean
  onCloseAssistant: () => void
  /** Request the live camera view (the assistant's "open live view" handoff target). */
  onRequestLiveView: () => void
}

export function PrinterAttentionDialogs({
  printer,
  status,
  submitting,
  onCommand,
  filamentRecoveryOpen,
  filamentRecoverySources,
  onCloseFilamentRecovery,
  onOpenFilamentRecovery,
  assistantOpen,
  assistantCanOpenLiveView,
  assistantCanLoadFilament,
  onCloseAssistant,
  onRequestLiveView
}: PrinterAttentionDialogsProps) {
  return (
    <>
      {filamentRecoveryOpen && (
        <FilamentRecoveryDialog
          printerName={printer.name}
          sources={filamentRecoverySources}
          submitting={submitting}
          onClose={onCloseFilamentRecovery}
          onLoad={(command) => {
            onCloseFilamentRecovery()
            onCommand(command)
          }}
        />
      )}
      {assistantOpen && status && (
        <PrinterAssistantDialog
          printerName={printer.name}
          printerModel={printer.model}
          printerSerial={printer.serial}
          status={status}
          canOpenLiveView={assistantCanOpenLiveView}
          canLoadFilament={assistantCanLoadFilament}
          onClose={onCloseAssistant}
          onOpenLiveView={() => {
            onCloseAssistant()
            onRequestLiveView()
          }}
          onLoadFilament={() => {
            onCloseAssistant()
            onOpenFilamentRecovery()
          }}
        />
      )}
    </>
  )
}
