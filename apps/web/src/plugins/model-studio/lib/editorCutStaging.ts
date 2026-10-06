/**
 * Stages Cut tool halves, their carried volumes, and loose dowel pins as imports.
 * World-space helpers and connectors take the half's orientation and rebase before
 * staging as parts at identity. `editorCutAction.ts` owns the safety gates and single
 * history mutation; `editorCutCommit.ts` places pieces and prepares the relationship.
 */
import type { SceneEditPartSubtype, StagedImport } from '@printstream/shared'
import type { EditorImportStore } from './editorImportStore'
import {
  drillBoresIntoHalf,
  helperVolumeCutSides,
  orientCutHalfSoup,
  rebaseTriangleSoup,
  shiftTriangleSoup,
  triangleSoupToBinaryStl,
  triangleSoupXYCenter,
  type CutAxis,
  type CutHalfOrientation
} from './meshCut'
import { connectorBoresForSide, connectorVolumes, type CutConnector } from './cutConnectors'

export interface CutHelperVolume {
  soup: Float32Array
  subtype: SceneEditPartSubtype
  name: string
  filamentId: number | null
}

export interface CutHalfToStage {
  soup: Float32Array
  suffix: string
  side: 'lower' | 'upper'
  orientation: CutHalfOrientation
}

export interface StagedCutHalf {
  import: StagedImport
  placement: { x: number; y: number }
  halfWidth: number
  halfDepth: number
  carried: Array<{ volume: CutHelperVolume; importId: string; soup: Float32Array }>
  connectorParts: Array<{
    importId: string
    subtype: SceneEditPartSubtype
    name: string
    soup: Float32Array
    connector: CutConnector
  }>
}

interface CutStagingContext {
  instanceName: string
  axis: CutAxis
  offset: number
  connectors: readonly CutConnector[]
  helperVolumes: readonly CutHelperVolume[]
  importStore: Pick<EditorImportStore, 'stageFile'>
}

/** Preserve the normalization boundary: halves and pins are objects, attached volumes are parts. */
async function stageCutSoup(
  store: Pick<EditorImportStore, 'stageFile'>,
  soup: Float32Array,
  name: string,
  normalization: 'object' | 'part'
): Promise<StagedImport> {
  const stl = triangleSoupToBinaryStl(soup)
  const file = new File([stl], `${name}.stl`, { type: 'application/octet-stream' })
  return store.stageFile(file, normalization)
}

/** Stage one kept half and the volumes that belong to it. */
export async function stageCutHalf(half: CutHalfToStage, context: CutStagingContext): Promise<StagedCutHalf> {
  const { axis, offset, connectors, helperVolumes, importStore } = context

  // Drill each hole into the visible half, not just a translucent negative volume seen through
  // the surface. A bore the drill declines keeps its negative volume, so one failed connector
  // cannot silently lose its hole or corrupt the whole piece.
  const bores = connectorBoresForSide(connectors, axis, half.side)
  const { soup, drilled } = drillBoresIntoHalf(
    half.soup,
    bores.map((bore) => bore.soup),
    axis,
    offset,
    half.side
  )
  const drilledConnectors = new Set(
    bores.filter((_, index) => drilled[index]).map((bore) => bore.connectorIndex)
  )

  // Preserve the original world XY centre before rotating. Orient before rebasing so the new
  // resting face is floored; helpers are assigned to a side in the original cut frame below.
  const placement = triangleSoupXYCenter(soup)
  orientCutHalfSoup(soup, axis, half.side, half.orientation)
  const { offset: rebaseOffset } = rebaseTriangleSoup(soup)
  const stagedImport = await stageCutSoup(importStore, soup, `${context.instanceName} (${half.suffix})`, 'object')

  // BambuStudio carries each helper whole onto every half it overlaps. Stage it as a part at
  // identity: object normalization would recenter the already transformed soup away from the cut.
  const carried = await Promise.all(helperVolumes
    .filter((volume) => helperVolumeCutSides(volume.soup, axis, offset)[half.side])
    .map(async (volume) => {
      const carriedSoup = shiftTriangleSoup(
        orientCutHalfSoup(volume.soup.slice(), axis, half.side, half.orientation),
        rebaseOffset
      )
      const stagedVolume = await stageCutSoup(importStore, carriedSoup, volume.name, 'part')
      return { volume, importId: stagedVolume.importId, soup: carriedSoup }
    }))

  const stagedConnectorParts = await Promise.all(connectors.map(async (connector, index) => {
    // A successfully drilled bore has no remaining negative volume to stage. Decide per
    // connector so a skipped bore still receives its matching negative part.
    if (drilledConnectors.has(index)) return null
    const volumes = connectorVolumes(connector, axis)
    const side = half.side === 'upper' ? volumes.upper : volumes.lower
    const connectorSoup = shiftTriangleSoup(
      orientCutHalfSoup(side.soup.slice(), axis, half.side, half.orientation),
      rebaseOffset
    )
    const name = `Connector-${index + 1}`
    const stagedPart = await stageCutSoup(importStore, connectorSoup, name, 'part')
    return { importId: stagedPart.importId, subtype: side.subtype, name, soup: connectorSoup, connector }
  }))
  const connectorParts = stagedConnectorParts.filter((part): part is NonNullable<typeof part> => part !== null)

  // The extents are measured after orientation and rebase for the bed clamp in EditorView.
  let halfWidth = 0
  let halfDepth = 0
  for (let index = 0; index < soup.length; index += 3) {
    halfWidth = Math.max(halfWidth, Math.abs(soup[index]!))
    halfDepth = Math.max(halfDepth, Math.abs(soup[index + 1]!))
  }
  return { import: stagedImport, placement, halfWidth, halfDepth, carried, connectorParts }
}

/** Stage loose dowel pins as printable objects beside the halves. */
export async function stageCutDowelPins(context: CutStagingContext): Promise<Array<{ staged: StagedImport; name: string }>> {
  const dowels = context.connectors.filter((connector) => connector.type === 'dowel')
  return Promise.all(dowels.map(async (connector, index) => {
    const soup = connectorVolumes(connector, context.axis).pin!
    rebaseTriangleSoup(soup)
    const name = `${context.instanceName} (dowel ${index + 1})`
    const staged = await stageCutSoup(context.importStore, soup, name, 'object')
    return { staged, name }
  }))
}
