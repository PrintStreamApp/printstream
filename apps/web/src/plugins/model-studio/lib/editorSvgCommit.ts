/**
 * Stages and commits one SVG tool action. Preparation, refusal, and all geometry staging finish
 * before a history checkpoint or live state mutation. EditorView supplies its current scene and
 * UI callbacks; this module owns the three artwork paths: re-edit, hosted part, standalone object.
 */
import * as THREE from 'three'
import { extractErrorMessage } from '@printstream/shared'
import type { SvgToolValue } from '../SvgToolPanel'
import { printableMeshBox, rotorOf } from '../editorGeometry'
import { toast } from '../../../lib/toast'
import { addedPartDropPosition, soupSize } from './addedParts'
import type { EditorImportStore } from './editorImportStore'
import {
  addedPartHostId,
  instanceFromStagedImport,
  planSvgReextrude,
  stagedFootprint,
  svgArtworkParts,
  type EditorInstance,
  type EditorState
} from './editorModel'
import { applyEditorSvgReextrude } from './editorSvgReextrudeCommit'
import { prepareSvgReextrudeSafety } from './editorSvgReextrudeSafety'
import { appendEditorSvgParts, stageEditorSvgPieces, storeEditorSvgSource } from './editorSvgPartCommit'
import { prepareSvgArtwork } from './svgArtworkPreparation'
import { svgObjectFrameShift, type ParsedSvg } from './svgGeometry'
import { triangleSoupToBinaryStl } from './meshCut'

interface SvgReeditTarget {
  entryPath: string
  hostId: number
  loadedMarkup: string
}

export interface EditorSvgCommitOptions {
  artwork: ParsedSvg | null
  settings: SvgToolValue
  fileName: string | null
  markup: string | null
  archiveEntries: readonly string[]
  reedit: SvgReeditTarget | null
  stateRef: { current: EditorState | null }
  activePlateIndex: number
  selectedKey: string | null
  groupByKey: ReadonlyMap<string, THREE.Group>
  importStore: EditorImportStore
  projectFilamentCount: () => number
  recordHistory: () => void
  addInstance: (
    instance: EditorInstance,
    footprint: ReturnType<typeof stagedFootprint>,
    options: { recordHistory: false }
  ) => boolean
  publishBakedState: (state: EditorState) => void
  refreshAddedPartMeshes: () => void
  regenerateThumbnail: () => void
  closeTool: () => void
  setImporting: (busy: boolean) => void
}

type PreparedSvgArtwork = NonNullable<ReturnType<typeof prepareSvgArtwork>>

/** Run one SVG Add or Update and report a stage or commit failure to the user and client log. */
export async function commitEditorSvgArtwork(options: EditorSvgCommitOptions): Promise<void> {
  const { artwork } = options
  if (!artwork) return

  options.setImporting(true)
  try {
    const state = options.stateRef.current
    const prepared = prepareSvgArtwork({
      artwork,
      settings: options.settings,
      fileName: options.fileName,
      markup: options.markup,
      state,
      archiveEntries: options.archiveEntries,
      reedit: options.reedit
    })
    if (!prepared) return

    if (state && options.reedit) {
      await reextrudeArtwork(options, prepared, state, options.reedit)
      return
    }

    const plate = state?.plates.find((entry) => entry.index === options.activePlateIndex)
    const instance = options.selectedKey
      ? plate?.instances.find((entry) => entry.key === options.selectedKey) ?? null
      : null
    const group = options.selectedKey ? options.groupByKey.get(options.selectedKey) : null
    const hostId = instance ? addedPartHostId(instance) : null
    if (state && instance && group && hostId != null) {
      await addHostedArtwork(options, prepared, state, instance, group, hostId)
      return
    }

    await addStandaloneArtwork(options, prepared)
  } catch (error) {
    console.warn('[editor] could not add SVG artwork', extractErrorMessage(error))
    toast.error(extractErrorMessage(error) || 'That artwork could not be added.')
  } finally {
    options.setImporting(false)
  }
}

/** Replace one artwork's surviving pieces, retaining each baked survivor's material and pose. */
async function reextrudeArtwork(
  options: EditorSvgCommitOptions,
  prepared: PreparedSvgArtwork,
  state: EditorState,
  reedit: SvgReeditTarget
): Promise<void> {
  const { soups, split, partName } = prepared
  // The artwork's own host wins over whichever object is now selected.
  const artworkHost = state.plates.flatMap((entry) => entry.instances)
    .find((entry) => addedPartHostId(entry) === reedit.hostId) ?? null
  const artworkGroup = artworkHost ? options.groupByKey.get(artworkHost.key) : null
  const dropPosition = artworkHost && artworkGroup
    ? addedPartDropPosition(
      options.settings.operation,
      printableMeshBox(artworkGroup),
      soupSize(soups[0]!.soup),
      (point) => rotorOf(artworkGroup).worldToLocal(point)
    )
    : new THREE.Vector3()
  const survivors = svgArtworkParts(state, reedit.hostId, reedit.entryPath)
  const plan = planSvgReextrude(survivors, soups.map((piece) => piece.index), split)
  const safety = prepareSvgReextrudeSafety(state, reedit.hostId, options.settings.operation, plan)
  if (safety.refused) {
    toast.error('This object would have nothing left to print. Keep a printed part before replacing the artwork.')
    return
  }

  const staged = await stageEditorSvgPieces(options.importStore, soups, partName)
  options.recordHistory()
  const result = applyEditorSvgReextrude({
    state,
    hostId: reedit.hostId,
    operation: options.settings.operation,
    prepared,
    plan,
    safety,
    stagedPieces: staged,
    dropPosition,
    fallbackFilamentId: artworkHost?.filamentId ?? 1
  })
  if (result.bakedStateChanged) options.publishBakedState(state)
  options.refreshAddedPartMeshes()
  options.regenerateThumbnail()
  options.closeTool()
  toast.success([
    result.replacedCount > 0 ? `Updated ${result.replacedCount} part${result.replacedCount === 1 ? '' : 's'}` : null,
    result.addedCount > 0 ? `added ${result.addedCount}` : null,
    result.removedCount > 0 ? `removed ${result.removedCount}` : null
  ].filter(Boolean).join(', ') + ' of the artwork.')
}

/** Add every SVG shape beside one selected model at a shared artwork origin. */
async function addHostedArtwork(
  options: EditorSvgCommitOptions,
  prepared: PreparedSvgArtwork,
  state: EditorState,
  instance: EditorInstance,
  group: THREE.Group,
  hostId: number
): Promise<void> {
  const { soups, split, partName } = prepared
  const rotor = rotorOf(group)
  rotor.updateWorldMatrix(true, false)
  const position = addedPartDropPosition(
    options.settings.operation,
    printableMeshBox(group),
    soupSize(soups[0]!.soup),
    (point) => rotor.worldToLocal(point)
  )
  const staged = await stageEditorSvgPieces(options.importStore, soups, partName)
  options.recordHistory()
  appendEditorSvgParts({
    state, hostId, prepared, stagedPieces: staged,
    operation: options.settings.operation, filamentId: instance.filamentId, position
  })
  options.refreshAddedPartMeshes()
  options.regenerateThumbnail()
  options.closeTool()
  toast.success(split ? `Added ${soups.length} parts from the artwork.` : 'Added the artwork as a part.')
}

/** Make the largest SVG shape the body and attach the remaining shapes after all staging. */
async function addStandaloneArtwork(
  options: EditorSvgCommitOptions,
  prepared: PreparedSvgArtwork
): Promise<void> {
  const ordered = [...prepared.soups].sort((a, b) => b.coverage - a.coverage)
  const body = ordered[0]!
  const frame = svgObjectFrameShift(body.soup)
  const stagedBody = await options.importStore.stageFile(
    new File([triangleSoupToBinaryStl(body.soup)], `${prepared.partName(body.index)}.stl`, { type: 'application/octet-stream' }),
    'object'
  )
  // All geometry must be ready before the first session mutation, or a failed piece leaves a body.
  const stagedRest = await stageEditorSvgPieces(options.importStore, ordered.slice(1), prepared.partName)
  if (options.projectFilamentCount() === 0) {
    toast.error('Add a material to the project before adding objects.')
    return
  }

  options.recordHistory()
  const created = instanceFromStagedImport(stagedBody, options.importStore.meshUrl)
  // Objects have no persistent SVG authoring channel yet; the body record lasts this session.
  const bodyRecord = prepared.recordFor(body.index)
  if (bodyRecord) created.svgPart = bodyRecord
  const liveForSources = options.stateRef.current
  if (liveForSources) storeEditorSvgSource(liveForSources, prepared)
  // The gesture already owns its checkpoint. The shared object add must not take a second one.
  if (!options.addInstance(created, stagedFootprint(stagedBody), { recordHistory: false })) return
  options.closeTool()
  toast.success(ordered.length > 1
    ? `Added the artwork. Its ${ordered.length - 1} other shapes are parts of it.`
    : 'Added the artwork.')

  const restHostId = addedPartHostId(created)
  const live = options.stateRef.current
  if (ordered.length <= 1 || restHostId == null || !live) return
  // Object staging moved the body's origin; the extra pieces retain their drawing coordinates.
  appendEditorSvgParts({
    state: live, hostId: restHostId, prepared, stagedPieces: stagedRest,
    operation: 'normal_part', filamentId: created.filamentId,
    position: new THREE.Vector3(frame.x, frame.y, frame.z)
  })
  options.refreshAddedPartMeshes()
  options.regenerateThumbnail()
}
