/**
 * The AMS/spool configuration dialogs reachable from a printer card: global AMS settings, the
 * per-unit drying controls, the per-slot filament editor, and the external-spool editor. All are
 * management-gated and fire {@link PrinterCommand}s through a single `onCommand`. Grouped out of
 * PrinterCard so its render tree isn't interleaved with four AMS modal configs.
 */
import type { AmsSlot, AmsUnit, ExternalSpool, Printer, PrinterCommand, PrinterStatus } from '@printstream/shared'
import { AmsDryingModal, AmsSettingsModal } from './AmsModals'
import { AmsSlotEditModal } from './AmsSlotEditModal'
import { ExternalSpoolEditModal } from './ExternalSpoolEditModal'
import { resolveFilamentChangeTargetTemp } from '../../lib/printersViewHelpers'

export interface PrinterAmsDialogsProps {
  printer: Printer
  status: PrinterStatus | undefined
  canManagePrinter: boolean
  submitting: boolean
  onCommand: (command: PrinterCommand) => void
  amsSettingsOpen: boolean
  onCloseAmsSettings: () => void
  dryingUnit: AmsUnit | null
  onCloseDrying: () => void
  editingSlot: { unit: AmsUnit; slot: AmsSlot } | null
  currentEditingUnit: AmsUnit | null
  currentEditingSlot: AmsSlot | null
  onCloseSlot: () => void
  editingExternalSpool: ExternalSpool | null
  currentEditingExternalSpool: ExternalSpool | null
  externalSpoolCount: number
  defaultExternalSpoolTemp: number
  onCloseExternalSpool: () => void
}

export function PrinterAmsDialogs({
  printer,
  status,
  canManagePrinter,
  submitting,
  onCommand,
  amsSettingsOpen,
  onCloseAmsSettings,
  dryingUnit,
  onCloseDrying,
  editingSlot,
  currentEditingUnit,
  currentEditingSlot,
  onCloseSlot,
  editingExternalSpool,
  currentEditingExternalSpool,
  externalSpoolCount,
  defaultExternalSpoolTemp,
  onCloseExternalSpool
}: PrinterAmsDialogsProps) {
  if (!canManagePrinter) return null

  return (
    <>
      {amsSettingsOpen && status && (
        <AmsSettingsModal
          printerName={printer.name}
          settings={status.amsSettings}
          submitting={submitting}
          onClose={onCloseAmsSettings}
          onUpdateUserSettings={(settingsCommand) => onCommand(settingsCommand)}
          onUpdateFilamentBackup={(enabled) => onCommand({ type: 'setAmsFilamentBackup', enabled })}
        />
      )}
      {dryingUnit && (
        <AmsDryingModal
          printerName={printer.name}
          unit={dryingUnit}
          submitting={submitting}
          onClose={onCloseDrying}
          onStart={(command) => onCommand(command)}
          onStop={(amsId) => onCommand({ type: 'stopAmsDrying', amsId })}
        />
      )}
      {editingSlot && (
        <AmsSlotEditModal
          printerId={printer.id}
          status={status}
          unit={currentEditingUnit ?? editingSlot.unit}
          slot={currentEditingSlot ?? editingSlot.slot}
          defaultNozzleTemp={resolveFilamentChangeTargetTemp(currentEditingSlot ?? editingSlot.slot) ?? 220}
          rescanActive={currentEditingSlot?.isReading ?? false}
          onClose={onCloseSlot}
        />
      )}
      {editingExternalSpool && (
        <ExternalSpoolEditModal
          printerId={printer.id}
          status={status}
          spool={currentEditingExternalSpool ?? editingExternalSpool}
          spoolCount={externalSpoolCount}
          defaultNozzleTemp={defaultExternalSpoolTemp}
          onClose={onCloseExternalSpool}
        />
      )}
    </>
  )
}
