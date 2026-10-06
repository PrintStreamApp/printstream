/**
 * Library file and version response mapping.
 *
 * Display chips are derived inline for a single file or read from the row cache for listings.
 * Missing chips warm in the background and emit one debounced library change after persistence;
 * immutable receipt snapshots may opt out so old metadata never overwrites the current head.
 */
import type { LibraryFile, LibraryFileVersion as LibraryFileVersionDto } from '@printstream/shared'
import {
  LIBRARY_DERIVED_CHIPS_VERSION,
  parseDerivedChips,
  serializeDerivedChips,
  warmLibraryFileDerivedChips,
  deriveChips,
  type DerivedChips
} from '../lib/library-derived-chips.js'
import { prisma } from '../lib/prisma.js'
import { broadcastLibraryChangedDebounced } from '../lib/ws-resource-events.js'
import { readLibraryThreeMfIndex } from './library-media.js'

type LibraryFileRow = {
  sourceTagSnapshotJson?: string | null
  id: string
  workspaceId: string
  name: string
  ownerBridgeId?: string | null
  sizeBytes: number
  uploadedAt: Date
  kind: string
  storedPath: string
  thumbnailPath: string | null
  folderId: string | null
  hidden: boolean
  currentVersionNumber: number
  snapshotKey: string | null
  deletedAt?: Date | null
  createdById?: string | null
  createdByName?: string | null
  restoredFromVersionNumber?: number | null
}

type LibraryFileVersionRow = {
  sourceTagSnapshotJson?: string | null
  id: string
  libraryFileId: string
  workspaceId: string
  name: string
  ownerBridgeId?: string | null
  sizeBytes: number
  uploadedAt: Date
  kind: string
  storedPath: string
  thumbnailPath: string | null
  folderId: string | null
  versionNumber: number
  createdById?: string | null
  createdByName?: string | null
  restoredFromVersionNumber?: number | null
}


export async function toDto(row: {
  id: string
  name: string
  ownerBridgeId?: string | null
  sizeBytes: number
  uploadedAt: Date
  kind: string
  storedPath: string
  thumbnailPath: string | null
  folderId: string | null
  createdByName?: string | null
  currentVersionNumber?: number | null
  restoredFromVersionNumber?: number | null
  derivedChipsJson?: string | null
  derivedChipsVersion?: number | null
  printCount?: number | null
  lastPrintedAt?: Date | null
}, options: {
  cacheOnly?: boolean
  favorite?: boolean
  persistDerived?: boolean
  /** False for immutable receipt snapshots whose old metadata must never be written onto the head. */
  warmDerived?: boolean
} = {}): Promise<LibraryFile> {
  let chips: DerivedChips = { plateCount: 0, compatiblePrinterModels: [], plateTypeChips: [], nozzleSizeChips: [], projectFilamentChips: [] }
  // Empty chips are ambiguous on the wire ("not derived yet" vs "derived: nothing there"), and the
  // web needs the difference to show a processing indicator instead of a silently bare card.
  let metadataPending = false
  if (row.kind === '3mf' || row.kind === 'gcode') {
    try {
      // List path (`cacheOnly`): read the chips persisted on the row: O(1), no
      // parse, no bridge RPC. On a miss/stale row, return empty chips now and warm
      // (inspect + derive + persist) in the background so the next listing is
      // served from the row. Single-file/upload paths derive fresh inline.
      const cached = parseDerivedChips(row.derivedChipsJson, row.derivedChipsVersion, row.storedPath)
      if (options.cacheOnly) {
        if (cached) {
          chips = cached
        } else {
          metadataPending = true
          if (options.warmDerived !== false) {
            warmLibraryFileDerivedChips(row, {
              deriveChips: async (file) => deriveChips(await readLibraryThreeMfIndex(file)),
              persist: async (fileId, json, version) => {
                const updated = await prisma.libraryFile.update({
                  where: { id: fileId },
                  data: { derivedChipsJson: json, derivedChipsVersion: version },
                  select: { workspaceId: true }
                })
                // The listing that triggered this warm already went out with `metadataPending`
                // cards; without a signal the chips appear only on an accidental refetch.
                // Debounced: a stale listing warms one row apiece (every row after a parser
                // version bump), and one refetch serves them all.
                broadcastLibraryChangedDebounced(updated.workspaceId)
              },
              log: (message, error) => console.warn(message, error)
            })
          }
        }
      } else {
        chips = deriveChips(await readLibraryThreeMfIndex(row))
        // Upload paths persist what they just derived (the upload response already paid for the
        // parse), so the listing that follows serves chips from the row instead of flashing a
        // processing card and re-deriving. Opt-in: `toVersionDto` also takes this branch with
        // VERSION rows whose ids must never be written onto `LibraryFile`.
        if (options.persistDerived && !cached) {
          await prisma.libraryFile.update({
            where: { id: row.id },
            data: { derivedChipsJson: serializeDerivedChips(chips, row.storedPath), derivedChipsVersion: LIBRARY_DERIVED_CHIPS_VERSION }
          }).catch((error: unknown) => {
            // The DTO is already correct; losing the cache write only costs a background re-derive.
            console.warn(`[library] could not persist derived chips for ${row.id}`, error)
          })
        }
      }
    } catch {
      chips = { plateCount: 0, compatiblePrinterModels: [], plateTypeChips: [], nozzleSizeChips: [], projectFilamentChips: [] }
      // An inline derive failure (e.g. the owning bridge is unreachable) leaves the metadata
      // unresolved, not absent: list-path warms keep retrying, so "pending" stays honest.
      metadataPending = true
    }
  }
  const { compatiblePrinterModels, plateTypeChips, nozzleSizeChips, projectFilamentChips, plateCount } = chips
  return {
    id: row.id,
    name: row.name,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt.toISOString(),
    kind: row.kind as LibraryFile['kind'],
    thumbnailPath: row.thumbnailPath,
    folderId: row.folderId,
    compatiblePrinterModels,
    plateTypeChips,
    nozzleSizeChips,
    projectFilamentChips,
    plateCount,
    ...(metadataPending ? { metadataPending: true } : {}),
    ...(chips.geometryOnly ? { geometryOnly: true } : {}),
    ...(chips.objectExport ? { objectExport: true } : {}),
    ...(chips.needsSettingsRepair ? { needsSettingsRepair: true } : {}),
    ...(chips.settingsRepairReasons?.length ? { settingsRepairReasons: chips.settingsRepairReasons } : {}),
    ...(chips.unrepairableSettingsRepairReasons?.length ? { unrepairableSettingsRepairReasons: chips.unrepairableSettingsRepairReasons } : {}),
    ...(chips.projectVersion ? { projectVersion: chips.projectVersion } : {}),
    ...(chips.slicedWithFilamentTrackSwitch ? { slicedWithFilamentTrackSwitch: true } : {}),
    ...(row.currentVersionNumber ? { currentVersionNumber: row.currentVersionNumber } : {}),
    createdByName: row.createdByName ?? null,
    restoredFromVersionNumber: row.restoredFromVersionNumber ?? null,
    favorite: options.favorite ?? false,
    printCount: row.printCount ?? 0,
    lastPrintedAt: row.lastPrintedAt ? row.lastPrintedAt.toISOString() : null
  }
}

export async function toVersionDto(row: LibraryFileRow | LibraryFileVersionRow): Promise<LibraryFileVersionDto> {
  const dto = await toDto({
    id: row.id,
    name: row.name,
    ownerBridgeId: row.ownerBridgeId,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt,
    kind: row.kind,
    storedPath: row.storedPath,
    thumbnailPath: row.thumbnailPath,
    folderId: row.folderId,
    createdByName: row.createdByName ?? null,
    restoredFromVersionNumber: row.restoredFromVersionNumber ?? null
  })
  return {
    ...dto,
    libraryFileId: 'libraryFileId' in row ? row.libraryFileId : row.id,
    versionId: 'libraryFileId' in row ? row.id : null,
    versionNumber: 'versionNumber' in row ? row.versionNumber : row.currentVersionNumber,
    isCurrent: !('libraryFileId' in row)
  }
}
