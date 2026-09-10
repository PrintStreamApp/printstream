/**
 * The AMS/spool configuration dialogs reachable from a printer card: global AMS settings, the
 * per-unit drying controls, the per-slot filament editor, and the external-spool editor. All are
 * management-gated and fire {@link PrinterCommand}s through a single `onCommand`. Grouped out of
 * PrinterCard so its render tree isn't interleaved with four AMS modal configs.
 */
import {
  isPrinterActiveJobStage,
  printerModelSchema,
  supportsAmsSettingsReorder,
  type AmsSlot,
  type AmsUnit,
  type ExternalSpool,
  type Printer,
  type PrinterCommand,
  type PrinterModel,
  type PrinterStatus
} from '@printstream/shared'
import { AmsDryingModal, AmsSettingsModal } from './AmsModals'
import { AmsSlotEditModal } from './AmsSlotEditModal'
import { ExternalSpoolEditModal } from './ExternalSpoolEditModal'
import { usePromptDialog } from '../PromptDialogProvider'
import { resolveFilamentChangeTargetTemp } from '../../lib/printersViewHelpers'

/** A stored model string as a `PrinterModel`; anything unrecognised is `unknown`, never a guess. */
function printerModelOrUnknown(model: string): PrinterModel {
  const parsed = printerModelSchema.safeParse(model)
  return parsed.success ? parsed.data : 'unknown'
}

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
  const { confirm } = usePromptDialog()
  if (!canManagePrinter) return null

  return (
    <>
      {amsSettingsOpen && status && (
        <AmsSettingsModal
          printerName={printer.name}
          settings={status.amsSettings}
          canReorderAmsUnits={supportsAmsSettingsReorder(printerModelOrUnknown(printer.model))}
          submitting={submitting}
          onClose={onCloseAmsSettings}
          onUpdateUserSettings={(settingsCommand) => onCommand(settingsCommand)}
          onUpdateFilamentBackup={(enabled) => onCommand({ type: 'setAmsFilamentBackup', enabled })}
          onResetAmsOrder={async () => {
            const confirmed = await confirm({
              title: 'Reset AMS order?',
              description:
                'Every AMS unit disconnects at once. Reconnect them one at a time, in the order you want them numbered.',
              confirmLabel: 'Reset',
              color: 'warning'
            })
            if (confirmed) onCommand({ type: 'resetAmsOrder' })
          }}
        />
      )}
      {dryingUnit && (
        <AmsDryingModal
          printerName={printer.name}
          printing={isPrinterActiveJobStage(status?.stage)}
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
          printerModel={printer.model}
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
