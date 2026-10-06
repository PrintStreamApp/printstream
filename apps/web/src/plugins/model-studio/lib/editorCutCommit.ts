/**
 * Places staged Cut pieces and prepares their commit relationship.
 * The caller records one history checkpoint and swaps the plate and added parts together.
 * Only staged connector volumes appear in the saved relationship; drilled holes have no part.
 */
import * as THREE from 'three'
import { threeMfPartSubtypeCarriesFilament, type SceneEditPartSubtype, type StagedImport } from '@printstream/shared'
import type { CutConnector } from './cutConnectors'
import type { CutHelperVolume, StagedCutHalf as StagedCutPiece } from './editorCutStaging'
import {
  findFreePlatePosition,
  instanceFromStagedImport,
  type EditorAddedPart,
  type EditorCutGroup,
  type EditorInstance,
  type EditorPlate,
  type ImportMeshUrlResolver
} from './editorModel'

interface StagedCutHalf {
  import: { importId: string }
  carried: ReadonlyArray<{ volume: Pick<CutHelperVolume, 'subtype' | 'name' | 'filamentId'>; importId: string; soup: Float32Array }>
  connectorParts: ReadonlyArray<{
    importId: string
    subtype: SceneEditPartSubtype
    name: string
    soup: Float32Array
    connector: Pick<CutConnector, 'type' | 'radius' | 'height' | 'radiusTolerance' | 'heightTolerance'>
  }>
}

interface CutCommitInput {
  halves: ReadonlyArray<StagedCutHalf>
  pinImportIds: ReadonlyArray<string>
  /** Host IDs match the replacement order: kept halves first, then loose pins. */
  hostIds: ReadonlyArray<number | null>
  connectorCount: number
  nextPartKey: () => string
}

/** Centre an oriented half on the bed, retaining an oversize piece's true placement warning. */
function clampOntoBed(center: number, halfExtent: number, min: number, max: number): number {
  if (halfExtent * 2 > max - min) return (min + max) / 2
  return Math.min(Math.max(center, min + halfExtent), max - halfExtent)
}

interface CutReplacementInput {
  halves: ReadonlyArray<Pick<StagedCutPiece, 'import' | 'placement' | 'halfWidth' | 'halfDepth'>>
  pins: ReadonlyArray<{ staged: StagedImport; name: string }>
  plate: EditorPlate
  source: EditorInstance
  meshUrl: ImportMeshUrlResolver
}

/**
 * Place staged cut pieces in commit order. Keep the original in the provisional occupancy set to
 * preserve the existing free-spot choice; add each new piece so later pins cannot stack there.
 */
export function placeCutReplacementInstances({
  halves,
  pins,
  plate,
  source,
  meshUrl
}: CutReplacementInput): EditorInstance[] {
  const occupiedPlate = { ...plate, instances: [...plate.instances] }
  const replacements: EditorInstance[] = []

  halves.forEach(({ import: stagedImport, placement, halfWidth, halfDepth }, index) => {
    const next = instanceFromStagedImport(stagedImport, meshUrl)
    // The lower piece keeps its cut location. After a rotation, clamp the new footprint so it
    // rests on the bed; an oversized piece is centred and left for placement warnings to flag.
    next.position.set(
      clampOntoBed(placement.x, halfWidth, plate.bed.minX, plate.bed.maxX),
      clampOntoBed(placement.y, halfDepth, plate.bed.minY, plate.bed.maxY),
      0
    )
    if (index > 0) {
      const spot = findFreePlatePosition(occupiedPlate)
      next.position.set(spot.x, spot.y, 0)
    }
    next.filamentId = source.filamentId
    next.printable = source.printable
    replacements.push(next)
    occupiedPlate.instances.push(next)
  })

  for (const { staged, name } of pins) {
    const pin = instanceFromStagedImport(staged, meshUrl)
    const spot = findFreePlatePosition(occupiedPlate)
    pin.position.set(spot.x, spot.y, 0)
    pin.name = name
    pin.filamentId = source.filamentId
    pin.printable = source.printable
    replacements.push(pin)
    occupiedPlate.instances.push(pin)
  }

  return replacements
}

/**
 * The staged soup already carries the world transform and the half's rebase.
 * A second placement transform would detach a helper or connector from its cut face.
 */
function identityPart(
  key: string,
  importId: string,
  subtype: SceneEditPartSubtype,
  name: string,
  soup: Float32Array
): EditorAddedPart {
  return {
    key,
    importId,
    subtype,
    name,
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    soup
  }
}

/** Build the relationship and host parts that must land with the plate swap. */
export function prepareCutCommit({
  halves,
  pinImportIds,
  hostIds,
  connectorCount,
  nextPartKey
}: CutCommitInput): {
  cutGroup: EditorCutGroup | null
  carriedByHost: Map<number, EditorAddedPart[]>
  carriedCount: number
} {
  const pieceImportIds = [...halves.map((half) => half.import.importId), ...pinImportIds]
  // This is the last moment the cut relationship exists. The halves become ordinary imports
  // after the plate swap. A single kept half is not a cut group: sceneEditSchema requires at
  // least two import IDs and a one-sided chop must remain saveable.
  // List only connector volumes that still exist. Drilled holes have no mesh import to name;
  // connectorCount still records how many joints the user placed.
  const cutGroup: EditorCutGroup | null = pieceImportIds.length < 2 ? null : {
    importIds: pieceImportIds,
    connectorCount,
    connectors: halves.flatMap((half) => half.connectorParts.map(({ importId, connector }) => ({
      importId: half.import.importId,
      meshImportId: importId,
      type: connector.type,
      radius: connector.radius,
      height: connector.height,
      radiusTolerance: connector.radiusTolerance,
      heightTolerance: connector.heightTolerance
    })))
  }

  const carriedByHost = new Map<number, EditorAddedPart[]>()
  halves.forEach((half, index) => {
    const hostId = hostIds[index]
    if (hostId == null || (half.carried.length === 0 && half.connectorParts.length === 0)) return

    // Host IDs include loose pins after the halves; only halves can own carried volumes.
    const connectorParts = half.connectorParts.map((part) => identityPart(
      nextPartKey(), part.importId, part.subtype, part.name, part.soup
    ))
    const carriedParts = half.carried.map(({ volume, importId, soup }) => {
      const part = identityPart(nextPartKey(), importId, volume.subtype, volume.name, soup)
      if (threeMfPartSubtypeCarriesFilament(volume.subtype) && volume.filamentId != null) {
        part.filamentId = volume.filamentId
      }
      return part
    })
    carriedByHost.set(hostId, [...connectorParts, ...carriedParts])
  })

  return {
    cutGroup,
    carriedByHost,
    carriedCount: halves.reduce((total, half) => total + half.carried.length, 0)
  }
}
