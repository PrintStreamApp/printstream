/**
 * Freezes inventory tags from the selected physical slots before dispatch, independently of
 * RFID/gram accounting and print outcome. Unknown mappings never mean every loaded spool.
 * External starts can capture the active slots reported when first observed.
 */
import type { Prisma } from '@prisma/client'
import { trayIndexToAmsSlot, VIRTUAL_TRAY_MAIN_ID, type AmsSlotRef, type JobTag, type JobTagSnapshot, type PrinterStatus } from '@printstream/shared'
import { captureJobTags } from './job-tag-snapshots.js'

type CaptureDb = Pick<Prisma.TransactionClient, 'workspaceTag' | 'filamentSpool'>

/** Capture selected inventory spools, including RFID spools and spools without tags. */
export async function capturePrintJobTags(db: CaptureDb, workspaceId: string, input: {
  printerId: string
  fileIds?: string[]
  /** Pre-dispatch printer/file vocabulary, already frozen by the library entrypoint. */
  tags?: JobTag[]
  amsMapping?: number[] | null
  useAms?: boolean | null
  /** Only external starts use active-slot observations; queued jobs use their selected mapping. */
  observedStatus?: PrinterStatus | null
}): Promise<JobTagSnapshot> {
  const slots = selectedSlots(input)
  const spools = slots.length ? await db.filamentSpool.findMany({
    where: {
      workspaceId,
      loadedPrinterId: input.printerId,
      deletedAt: null,
      OR: slots.map((slot) => ({ loadedAmsId: slot.amsId, loadedSlotId: slot.slotId }))
    },
    select: { id: true }
  }) : []
  const spoolIds = spools.map((spool) => spool.id)
  const current = await captureJobTags(db, workspaceId, {
    ...(input.tags === undefined ? { printerId: input.printerId, fileIds: input.fileIds } : {}),
    spoolIds
  })
  return { tags: structuredClone([...(input.tags ?? []), ...current]), spoolIds }
}

/** Resolve explicit mappings first; unmapped entries are not physical slots. */
function selectedSlots(input: {
  amsMapping?: number[] | null
  useAms?: boolean | null
  observedStatus?: PrinterStatus | null
}): AmsSlotRef[] {
  if (input.amsMapping?.length) {
    return input.amsMapping.flatMap((index) => {
      const slot = trayIndexToAmsSlot(index)
      return slot ? [slot] : []
    })
  }
  if (input.useAms === false) return [{ amsId: VIRTUAL_TRAY_MAIN_ID, slotId: null }]
  const status = input.observedStatus
  if (!status) return []
  return [
    ...(status.ams ?? []).flatMap((unit) => unit.slots.filter((slot) => slot.active).map((slot) => ({ amsId: unit.unitId, slotId: slot.slot }))),
    ...(status.externalSpools ?? []).filter((spool) => spool.active).map((spool) => ({ amsId: spool.amsId, slotId: null }))
  ]
}
