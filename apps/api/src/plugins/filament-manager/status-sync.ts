/**
 * Status observer: keeps the spool library in sync with what the AMS reports.
 *
 * On each changed printer status it:
 * - auto-adds RFID-tagged Bambu spools not yet in the library (when the
 *   per-workspace `autoAddBambuSpools` setting is on),
 * - re-associates a known spool (matched by `bambuUuid`) with its current slot,
 * - syncs `remainingGrams` from the printer's reported remain% for
 *   printer-tracked spools (the Bambu half of the hybrid tracking model),
 * - clears the slot association of RFID spools that are no longer present.
 *
 * Manual, non-RFID assignments (`bambuUuid == null`) are never auto-unassigned
 * here — the AMS can only see RFID spools, so it must not clobber them.
 *
 * Runs outside any request context, so it uses `rootPrisma` with an explicit
 * workspace filter on every query. A per-printer signature skips DB work when the
 * relevant slot state has not changed since the last frame.
 *
 * Three rules keep the association honest, and each one is a bug this had:
 * - **Only a status carrying AMS UNITS is evidence.** A report with no units at all is
 *   a printer that has not told us about its trays — the placeholder a fresh
 *   `ManagedPrinter` starts from — and letting it reach the unassign loop wipes every
 *   association on the printer. `online` is not the test: several paths publish that
 *   placeholder with `online: true`.
 * - **The signature records SUCCESS, not attendance.** Recording it before the DB work
 *   meant one failed pass left a removed spool associated until the slots changed again.
 * - **One pass per printer at a time.** These frames arrive faster than the writes they
 *   trigger, and two overlapping passes resolve each other's stale reads backwards.
 */
import { resolveFilamentIdentity, type PrinterStatus } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { printerManager } from '../../lib/printer-manager.js'
import { rootPrisma } from '../../lib/prisma.js'
import { serializeColors } from './dto.js'
import { broadcastSpoolsChanged } from './events.js'
import { loadAutoAddBambuSpools } from './settings.js'

type SlotPresence = {
  amsId: number
  slotId: number | null
  trayUuid: string
  remainPercent: number | null
  filamentType: string | null
  color: string | null
  colors: string[]
  trayInfoIdx: string | null
}

function hasUuid(value: string | null): value is string {
  return value != null && value.length > 0
}

export function collectPresences(status: PrinterStatus): SlotPresence[] {
  const out: SlotPresence[] = []
  for (const unit of status.ams) {
    for (const slot of unit.slots) {
      if (!hasUuid(slot.trayUuid)) continue
      out.push({
        amsId: unit.unitId,
        slotId: slot.slot,
        trayUuid: slot.trayUuid,
        remainPercent: slot.remainPercent,
        filamentType: slot.filamentType,
        color: slot.color,
        colors: slot.colors,
        trayInfoIdx: slot.trayInfoIdx
      })
    }
  }
  for (const ext of status.externalSpools) {
    if (!hasUuid(ext.trayUuid)) continue
    out.push({
      amsId: ext.amsId,
      slotId: null,
      trayUuid: ext.trayUuid,
      remainPercent: ext.remainPercent,
      filamentType: ext.filamentType,
      color: ext.color,
      colors: ext.colors,
      trayInfoIdx: ext.trayInfoIdx
    })
  }
  return out
}

export function signature(presences: SlotPresence[]): string {
  // Colour + preset id are part of the signature so a corrected late RFID read
  // (e.g. colour arriving after a placeholder #000000) re-triggers the sync.
  return presences
    .map((p) => `${p.amsId}:${p.slotId ?? 'x'}:${p.trayUuid}:${p.remainPercent ?? 'x'}:${p.color ?? 'x'}:${p.trayInfoIdx ?? 'x'}`)
    .sort()
    .join('|')
}

function remainGramsFromPercent(remainPercent: number | null, netWeightGrams: number): number | null {
  if (remainPercent == null) return null
  return Math.round((remainPercent / 100) * netWeightGrams)
}

export function createStatusObserver(context: ApiPluginContext): (status: PrinterStatus) => void {
  // Last SUCCESSFULLY processed slot signature per printer; skips redundant DB work.
  // Recorded only once a pass completes, so a pass that throws part-way is retried by
  // the next frame instead of being remembered as handled. The pass is idempotent
  // (identity-keyed writes plus a re-query before the unassign loop), so a partial
  // failure costs a repeat, never a wrong result.
  const lastSignature = new Map<string, string>()
  // Tail of the pass chain per printer. Frames arrive faster than the DB work, and two
  // overlapping passes for one printer interleave destructively: the older frame's
  // presences would be compared against rows the newer frame had already moved, so it
  // re-assigns the spool that was removed and unassigns the one that is really there.
  // Nothing after that corrects it, because the next identical frame short-circuits.
  const chains = new Map<string, Promise<void>>()

  return (status: PrinterStatus): void => {
    const printerId = status.printerId
    const chained = (chains.get(printerId) ?? Promise.resolve())
      .then(() => handle(status))
      .catch((error) => {
        context.logger.error('Failed to sync filament spools from printer status', { printerId, error })
      })
      .finally(() => {
        // Only the tail clears the entry; an earlier link settling must not drop a
        // successor that is still queued behind it.
        if (chains.get(printerId) === chained) chains.delete(printerId)
      })
    chains.set(printerId, chained)
  }

  async function handle(status: PrinterStatus): Promise<void> {
    const workspaceId = printerManager.getWorkspaceId(status.printerId)
    if (!workspaceId || !(context.isEnabledForWorkspace?.(workspaceId) ?? true)) return

    // Reporting NO AMS units is not the same as reporting empty ones, and only the
    // second is evidence. A fresh `ManagedPrinter` starts from `makeOfflineStatus`,
    // whose `ams` is `[]`, and several paths publish that placeholder before the
    // printer's first real report — `hintOnline` on an SSDP sighting, an unparseable
    // bridge frame, any partial delta with no `ams` key. Reaching the unassign loop it
    // reads as "every slot is empty" and clears every RFID association on the printer.
    //
    // Note `online` does NOT distinguish these: `hintOnline` merges `{ online: true }`
    // onto the untouched placeholder, so an online status can still carry no AMS at all.
    // A real removal always arrives as a unit WITH empty slots, which passes here.
    //
    // Tested as "no SLOTS anywhere" rather than "no units", because both shapes mean the
    // same thing — a unit cloned forward from a previous status with no `tray` array
    // parsed yet has told us nothing about its trays either.
    //
    // The trade-off, stated: a printer that genuinely has no AMS never runs the
    // unassign loop, so a stale association from a previous AMS-equipped state would
    // need clearing by hand. Wiping on a placeholder is the worse failure.
    //
    // Deliberately does NOT record the signature, so the first real frame is processed
    // normally rather than short-circuiting against the placeholder's.
    if (status.ams.every((unit) => unit.slots.length === 0)) return

    const presences = collectPresences(status)
    const sig = signature(presences)
    if (lastSignature.get(status.printerId) === sig) return

    const autoAdd = await loadAutoAddBambuSpools(context.settings, workspaceId)
    let mutated = false

    const presentUuids = new Set(presences.map((p) => p.trayUuid))

    for (const presence of presences) {
      const existing = await rootPrisma.filamentSpool.findFirst({
        where: { workspaceId, bambuUuid: presence.trayUuid, deletedAt: null }
      })

      if (existing) {
        const data: Record<string, unknown> = { lastSeenAt: new Date() }
        let meaningful = false
        let locationChanged = false
        if (
          existing.loadedPrinterId !== status.printerId ||
          existing.loadedAmsId !== presence.amsId ||
          existing.loadedSlotId !== presence.slotId
        ) {
          data.loadedPrinterId = status.printerId
          data.loadedAmsId = presence.amsId
          data.loadedSlotId = presence.slotId
          data.loadedAt = new Date()
          meaningful = true
          locationChanged = true
        }
        if (existing.archivedAt) {
          data.archivedAt = null
          meaningful = true
        }
        // An RFID tray is always a genuine Bambu spool; backfill brand for rows
        // auto-added before brand was recorded so they show + filter correctly.
        if (!existing.brand) {
          data.brand = 'Bambu'
          meaningful = true
        }
        // Printer-observed facts are refreshed on every sighting: the first
        // capture can be wrong (colour reads as #000000 while the RFID scan is
        // still in flight) and used to be frozen forever. User-editable
        // identity (colorName/materialSubtype/filamentType) is only BACKFILLED
        // when missing, never overwritten.
        const identity = resolveFilamentIdentity({
          color: presence.color,
          colors: presence.colors,
          trayName: null,
          trayInfoIdx: presence.trayInfoIdx,
          filamentType: presence.filamentType,
          trayUuid: presence.trayUuid
        })
        if (presence.color && identity.colorHex && existing.colorHex !== identity.colorHex) {
          data.colorHex = identity.colorHex
          data.colorsJson = serializeColors(presence.colors)
          // The stored colour name described the OLD colour; re-derive it unless
          // the user typed their own (conservative check: replace only when the
          // stored name is empty or equals what we would have derived before).
          const previousDerivedName = resolveFilamentIdentity({
            color: existing.colorHex,
            colors: [],
            trayName: null,
            trayInfoIdx: existing.trayInfoIdx,
            filamentType: existing.filamentType,
            trayUuid: presence.trayUuid
          }).colorName
          if (!existing.colorName || existing.colorName === previousDerivedName) {
            data.colorName = identity.colorName
          }
          meaningful = true
        }
        if (presence.trayInfoIdx && existing.trayInfoIdx !== presence.trayInfoIdx) {
          data.trayInfoIdx = presence.trayInfoIdx
          meaningful = true
        }
        if (!existing.materialSubtype && identity.subtype) {
          data.materialSubtype = identity.subtype
          meaningful = true
        }
        if (!existing.colorName && identity.colorName && data.colorName === undefined) {
          data.colorName = identity.colorName
          meaningful = true
        }
        if (existing.filamentType === 'Unknown' && presence.filamentType) {
          data.filamentType = presence.filamentType
          meaningful = true
        }
        if (existing.remainSource === 'printer') {
          const target = remainGramsFromPercent(presence.remainPercent, existing.netWeightGrams)
          if (target != null && Math.round(existing.remainingGrams) !== target) {
            data.remainingGrams = target
            meaningful = true
          }
        }
        await rootPrisma.filamentSpool.updateMany({ where: { id: existing.id, workspaceId }, data })
        if (meaningful) mutated = true
        if (locationChanged && presence.slotId != null) {
          context.printerEvents.emit('ams-slot.filament-loaded', {
            workspaceId,
            printerId: status.printerId,
            amsId: presence.amsId,
            slotId: presence.slotId,
            spoolId: existing.id,
            brand: (data.brand as string | undefined) ?? existing.brand,
            filamentType: (data.filamentType as string | undefined) ?? existing.filamentType,
            materialSubtype: (data.materialSubtype as string | undefined) ?? existing.materialSubtype,
            colorName: (data.colorName as string | undefined) ?? existing.colorName
          })
        }
        continue
      }

      if (autoAdd) {
        const netWeightGrams = 1000
        // Canonical identity fills the human-facing fields the tray encodes —
        // materialSubtype from the preset id ("PLA Basic") and the marketing
        // colour name ("Jade White") — so calibration/queue matching and every
        // display surface see the same identity this spool was born with.
        const identity = resolveFilamentIdentity({
          color: presence.color,
          colors: presence.colors,
          trayName: null,
          trayInfoIdx: presence.trayInfoIdx,
          filamentType: presence.filamentType,
          trayUuid: presence.trayUuid
        })
        await rootPrisma.filamentSpool.create({
          data: {
            workspaceId,
            brand: 'Bambu',
            filamentType: presence.filamentType ?? 'Unknown',
            materialSubtype: identity.subtype,
            colorName: identity.colorName,
            colorHex: identity.colorHex ?? presence.color,
            colorsJson: serializeColors(presence.colors),
            trayInfoIdx: presence.trayInfoIdx,
            bambuUuid: presence.trayUuid,
            netWeightGrams,
            remainingGrams: remainGramsFromPercent(presence.remainPercent, netWeightGrams) ?? netWeightGrams,
            remainSource: 'printer',
            loadedPrinterId: status.printerId,
            loadedAmsId: presence.amsId,
            loadedSlotId: presence.slotId,
            loadedAt: new Date(),
            lastSeenAt: new Date()
          }
        })
        mutated = true
      }
    }

    // Clear the association of RFID spools previously loaded on this printer
    // that are no longer present at their slot. Manual (non-RFID) assignments
    // are left untouched — the AMS cannot observe them.
    const loadedHere = await rootPrisma.filamentSpool.findMany({
      where: { workspaceId, loadedPrinterId: status.printerId, deletedAt: null, NOT: { bambuUuid: null } }
    })
    for (const spool of loadedHere) {
      const stillPresent = spool.bambuUuid != null && presentUuids.has(spool.bambuUuid)
        && presences.some((p) => p.trayUuid === spool.bambuUuid && p.amsId === spool.loadedAmsId && p.slotId === spool.loadedSlotId)
      if (!stillPresent) {
        await rootPrisma.filamentSpool.updateMany({
          where: { id: spool.id, workspaceId },
          data: { loadedPrinterId: null, loadedAmsId: null, loadedSlotId: null, loadedAt: null }
        })
        mutated = true
      }
    }

    // Everything above landed, so this frame is genuinely handled.
    lastSignature.set(status.printerId, sig)
    if (mutated) broadcastSpoolsChanged(context, workspaceId)
  }
}
