/**
 * Owns one Cut gesture from safety preflight through staging and the plate swap. Every imported
 * half, connector, and carried volume is staged before the single history checkpoint; the plate
 * and added parts then change in one state update so Undo restores the original together.
 */
import type { Dispatch, SetStateAction } from 'react'
import * as THREE from 'three'
import { toast } from '../../../lib/toast'
import { collectWorldTriangles } from './meshCut'
import type { CutConnector } from './cutConnectors'
import { nextInstanceKey, addedPartHostId, type EditorInstance, type EditorState } from './editorModel'
import type { EditorImportStore } from './editorImportStore'
import { prepareEditorCut } from './editorCutPreparation'
import { stageCutDowelPins, stageCutHalf, type CutHelperVolume } from './editorCutStaging'
import { placeCutReplacementInstances, prepareCutCommit } from './editorCutCommit'

type CutPreparationValues = Omit<Parameters<typeof prepareEditorCut>[0], 'soup' | 'connectorCount'>
type CutCommit = ReturnType<typeof prepareCutCommit>

export interface EditorCutActionOptions {
  selectedKey: string | null
  activePlateIndex: number
  stateRef: { current: EditorState | null }
  groupByKey: ReadonlyMap<string, THREE.Group>
  preparation: CutPreparationValues
  connectors: readonly CutConnector[]
  importStore: Pick<EditorImportStore, 'stageFile' | 'meshUrl'>
  collectHelperVolumes: (instance: EditorInstance, group: THREE.Group) => CutHelperVolume[]
  recordHistory: () => void
  setState: Dispatch<SetStateAction<EditorState | null>>
  invalidateAddedParts: () => void
  rebuildScene: () => void
  selectReplacement: (key: string) => void
  closeCutTool: () => void
  setCutting: (busy: boolean) => void
}

/** Swap a staged cut and its carried volumes together while preserving concurrent state writes. */
export function applyEditorCutAction(
  current: EditorState,
  activePlateIndex: number,
  originalKey: string,
  replacements: EditorInstance[],
  commit: CutCommit
): EditorState {
  const addedParts = { ...(current.addedParts ?? {}) }
  for (const [hostId, parts] of commit.carriedByHost) addedParts[hostId] = parts

  return {
    ...current,
    addedParts,
    // Each cut keeps its own relation; a later cut must not erase earlier groups.
    ...(commit.cutGroup ? { cutGroups: [...(current.cutGroups ?? []), commit.cutGroup] } : {}),
    plates: current.plates.map((plate) => plate.index === activePlateIndex
      ? { ...plate, instances: [...plate.instances.filter((item) => item.key !== originalKey), ...replacements] }
      : plate)
  }
}

/** Preflight and stage a Cut before recording history or changing the editor session. */
export async function commitEditorCut(options: EditorCutActionOptions): Promise<void> {
  const key = options.selectedKey
  const plate = options.stateRef.current?.plates.find((entry) => entry.index === options.activePlateIndex)
  const instance = plate?.instances.find((entry) => entry.key === key)
  const group = key ? options.groupByKey.get(key) : undefined
  if (!key || !plate || !instance || !group) return

  const prepared = prepareEditorCut({
    ...options.preparation,
    soup: collectWorldTriangles(group),
    connectorCount: options.connectors.length
  })
  if (prepared.halves === null) {
    toast.error(prepared.error)
    return
  }

  options.setCutting(true)
  try {
    // The original instance must still be present when its helper volumes are collected.
    const stagingContext = {
      instanceName: instance.name,
      axis: options.preparation.axis,
      offset: options.preparation.offset,
      connectors: options.connectors,
      helperVolumes: options.collectHelperVolumes(instance, group),
      importStore: options.importStore
    }
    const staged = await Promise.all(prepared.halves.map((half) => stageCutHalf(half, stagingContext)))
    const dowelPins = await stageCutDowelPins(stagingContext)
    const replacements = placeCutReplacementInstances({
      halves: staged,
      pins: dowelPins,
      plate,
      source: instance,
      meshUrl: options.importStore.meshUrl
    })
    const commit = prepareCutCommit({
      halves: staged,
      pinImportIds: dowelPins.map(({ staged: pin }) => pin.importId),
      hostIds: replacements.map(addedPartHostId),
      connectorCount: options.connectors.length,
      nextPartKey: nextInstanceKey
    })

    options.recordHistory()
    options.setState((current) => current
      ? applyEditorCutAction(current, options.activePlateIndex, key, replacements, commit)
      : current)
    // A new instance list invalidates the viewport; moved volumes invalidate sidebar readers too.
    options.invalidateAddedParts()
    options.rebuildScene()
    options.selectReplacement(replacements[0]!.key)
    options.closeCutTool()

    const pieceCount = replacements.length - dowelPins.length
    toast.success(`Cut ${instance.name} into ${pieceCount === 2 ? 'two parts' : 'one part'}.`
      + (options.connectors.length > 0 ? ` Added ${options.connectors.length} connector${options.connectors.length === 1 ? '' : 's'}.` : '')
      + (dowelPins.length > 0 ? ` Printed ${dowelPins.length} dowel pin${dowelPins.length === 1 ? '' : 's'} alongside.` : '')
      + (commit.carriedCount > 0 ? ` Kept ${commit.carriedCount} helper volume${commit.carriedCount === 1 ? '' : 's'}.` : ''))
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Unable to cut the model.')
  } finally {
    options.setCutting(false)
  }
}
