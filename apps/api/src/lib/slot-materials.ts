/**
 * Durable, inventory-independent slot configuration. Workspace-scoped Setting rows hold only
 * user identity and the corresponding hardware fingerprint. The printer manager decorates
 * status with this identity; it never replaces the raw MQTT compatibility fields.
 * Empty/replaced/RFID trays invalidate the assignment. A short pending window lets the
 * printer echo a just-sent setting before comparing it. Assumes one API owner per printer.
 */
import { z } from 'zod'
import { hasBambuRfidTag, slotMaterialIdentitySchema, type PrinterCommand, type PrinterStatus } from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { scopeSettingKeyForWorkspace } from './workspace-settings.js'

const recordSchema = z.object({
  workspaceId: z.string(),
  printerId: z.string(),
  amsId: z.number(),
  slotId: z.number(),
  identity: slotMaterialIdentitySchema,
  trayInfoIdx: z.string(),
  trayType: z.string(),
  color: z.string(),
  savedAt: z.number()
})
type SavedSlotMaterial = z.infer<typeof recordSchema>
const records = new Map<string, { record: SavedSlotMaterial; serialized: string; confirmed: boolean }>()
const slotKey = (printerId: string, amsId: number, slotId: number) => `${printerId}:${amsId}:${slotId}`
const settingKey = (record: Pick<SavedSlotMaterial, 'workspaceId' | 'printerId' | 'amsId' | 'slotId'>) =>
  scopeSettingKeyForWorkspace(record.workspaceId, `printer.slotMaterial.${record.printerId}.${record.amsId}.${record.slotId}`)
const colorKey = (color: string | null | undefined) => (color ?? '').replace(/^#/, '').slice(0, 6).toUpperCase()

/** Startup-only global load; validate every row against its printer's current workspace. */
export async function loadSlotMaterials(printers: Array<{ id: string; workspaceId: string }>): Promise<void> {
  records.clear()
  const owners = new Map(printers.map((printer) => [printer.id, printer.workspaceId]))
  const rows = await rootPrisma.setting.findMany({ where: { key: { contains: ':printer.slotMaterial.' } } })
  for (const row of rows) {
    try {
      const record = recordSchema.parse(JSON.parse(row.value))
      if (owners.get(record.printerId) !== record.workspaceId || row.key !== settingKey(record)) continue
      records.set(slotKey(record.printerId, record.amsId, record.slotId), { record, serialized: row.value, confirmed: false })
    } catch (error) {
      console.warn('[slot-material] Invalid saved slot identity', error instanceof Error ? error.message : String(error))
    }
  }
}

/** Persist only after command delivery succeeds. Commands without identity clear an earlier manual assignment. */
export async function saveSlotMaterial(workspaceId: string, printerId: string, command: PrinterCommand): Promise<void> {
  if (!['setAmsSlot', 'setExternalSpool', 'resetAmsSlot', 'resetExternalSpool', 'rescanAmsSlot'].includes(command.type)) return
  if (!('amsId' in command)) return
  let slotId = -1
  if (command.type !== 'setExternalSpool' && command.type !== 'resetExternalSpool' && 'slotId' in command) {
    slotId = command.slotId
  }
  const key = slotKey(printerId, command.amsId, slotId)
  const location = { workspaceId, printerId, amsId: command.amsId, slotId }
  if ((command.type === 'setAmsSlot' || command.type === 'setExternalSpool') && command.materialIdentity) {
    const record: SavedSlotMaterial = {
      ...location,
      identity: command.materialIdentity,
      trayInfoIdx: command.trayInfoIdx,
      trayType: command.trayType,
      color: colorKey(command.trayColor),
      savedAt: Date.now()
    }
    const serialized = JSON.stringify(record)
    await rootPrisma.setting.upsert({
      where: { key: settingKey(record) },
      create: { key: settingKey(record), value: serialized },
      update: { value: serialized }
    })
    records.set(key, { record, serialized, confirmed: false })
  } else {
    await rootPrisma.setting.deleteMany({ where: { key: settingKey(location) } })
    records.delete(key)
  }
}

/** Attach PS identity without changing hardware fields. Expired assignments are removed durably, best-effort. */
export function decorateSlotMaterials(status: PrinterStatus): PrinterStatus {
  const decorate = <T extends { trayUuid: string | null; trayInfoIdx: string | null; filamentType: string | null; color: string | null; occupied?: boolean }>(tray: T, amsId: number, slotId: number): T & { materialIdentity: SavedSlotMaterial['identity'] | null } => {
    const key = slotKey(status.printerId, amsId, slotId)
    const saved = records.get(key)
    if (!saved) return { ...tray, materialIdentity: null }
    const matches = tray.occupied !== false && !hasBambuRfidTag(tray.trayUuid) && (tray.trayInfoIdx ?? '') === saved.record.trayInfoIdx
      && tray.filamentType === saved.record.trayType && colorKey(tray.color) === saved.record.color
    if (matches) saved.confirmed = true
    const pending = !saved.confirmed && Date.now() - saved.record.savedAt < 30_000
    if (status.online && (hasBambuRfidTag(tray.trayUuid) || (!matches && !pending))) {
      records.delete(key)
      // Conditional deletion cannot erase a newer user assignment while this write is in flight.
      void rootPrisma.setting.deleteMany({ where: { key: settingKey(saved.record), value: saved.serialized } })
        .catch((error) => console.warn('[slot-material] Could not remove replaced slot identity', error))
      return { ...tray, materialIdentity: null }
    }
    return { ...tray, materialIdentity: hasBambuRfidTag(tray.trayUuid) ? null : saved.record.identity }
  }
  return {
    ...status,
    ams: (status.ams ?? []).map((unit) => ({ ...unit, slots: unit.slots.map((slot) => decorate(slot, unit.unitId, slot.slot)) })),
    externalSpools: (status.externalSpools ?? []).map((spool) => decorate(spool, spool.amsId, -1))
  }
}

/** Local identity takes precedence over inventory while this slot has a manual assignment. */
export function manualSlotMaterial(query: { workspaceId: string; printerId: string; amsId: number; slotId: number | null }) {
  const saved = records.get(slotKey(query.printerId, query.amsId, query.slotId ?? -1))
  return saved?.record.workspaceId === query.workspaceId ? saved.record.identity : null
}

/** Clear a manual assignment when an inventory spool takes ownership of this slot. */
export async function clearSlotMaterial(workspaceId: string, printerId: string, amsId: number, slotId: number | null): Promise<void> {
  await rootPrisma.setting.deleteMany({ where: { key: settingKey({ workspaceId, printerId, amsId, slotId: slotId ?? -1 }) } })
  records.delete(slotKey(printerId, amsId, slotId ?? -1))
}

/** Remove persisted configuration when its owning printer is deleted. */
export async function removePrinterSlotMaterials(workspaceId: string, printerId: string): Promise<void> {
  await rootPrisma.setting.deleteMany({ where: { key: { startsWith: scopeSettingKeyForWorkspace(workspaceId, `printer.slotMaterial.${printerId}.`) } } })
  for (const [key, saved] of records) {
    if (saved.record.workspaceId === workspaceId && saved.record.printerId === printerId) records.delete(key)
  }
}
