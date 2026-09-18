/** Validate slot compatibility before command delivery, inventory release, or identity persistence. */
import { slotMaterialCompatibilityError, type PrinterCommand } from '@printstream/shared'
import { badRequest } from './http-error.js'
import { slotFilamentResolvers } from './slot-filament-registry.js'

/** Reject mismatches for manual and inventory assignments; lookup failures abort rather than bypass validation. */
export async function validateSlotMaterialCommand(workspaceId: string, printerId: string, command: PrinterCommand): Promise<void> {
  if (command.type !== 'setAmsSlot' && command.type !== 'setExternalSpool') return
  // Null identity transfers ownership to inventory. Do not resolve the old manual override here.
  const physical = command.materialIdentity ?? await slotFilamentResolvers.resolveInventory({
    workspaceId, printerId, amsId: command.amsId,
    slotId: command.type === 'setAmsSlot' ? command.slotId : null
  }, true)
  const reason = slotMaterialCompatibilityError(physical?.filamentType, command.trayType, command.trayInfoIdx)
  if (reason) throw badRequest(reason)
}
