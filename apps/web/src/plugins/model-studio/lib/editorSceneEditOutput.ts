/**
 * Adapts the editable scene and live slice settings into one save/slice SceneEdit.
 *
 * `editorModel` owns scene serialization; this boundary adds project-wide bed type, physical
 * filament order, pinned-base material aliases, saved-slot renumbering, and fresh thumbnails.
 * Both editor save and slice must receive the same complete edit.
 */
import type { SceneEdit, SceneEditFilament } from '@printstream/shared'
import {
  buildSceneEdit,
  buildSessionFilamentIdRemap,
  rebaseSceneEditFilamentIds,
  type EditorState
} from './editorModel'
import { reconcileSceneEditFilamentSequences } from './editorFilamentSequences'
import { withBaseMaterialReferences } from './materialReplacement'

/** The slice-controller fields that affect the emitted edit. */
export interface EditorSceneEditSettings {
  projectFilaments: readonly { projectFilamentId: number; mixedFilament?: unknown }[]
  plateType: string
  desiredFilaments: SceneEditFilament[] | null
}

interface SceneEditOutputOptions {
  thumbnails?: Array<{ plateIndex: number; png: string }>
}

/** Build the complete edit over the session's pinned source material identity. */
export function buildEditorSceneEdit(
  current: EditorState,
  settings?: EditorSceneEditSettings,
  options?: SceneEditOutputOptions
): SceneEdit {
  const raw = buildSceneEdit(current)
  const base = reconcileSceneEditFilamentSequences(raw, settings?.projectFilaments ?? [])
  const plateType = settings?.plateType.trim()
  // Always carry this key, even as null. Presence tells the bake this client authors per-plate
  // bed overrides; omitting it promotes a source plate override into the project-wide value.
  const withPlateType = { ...base, plateType: plateType || null }
  let withFilaments: SceneEdit = settings?.desiredFilaments
    ? { ...withPlateType, filaments: settings.desiredFilaments }
    : withPlateType

  // Source aliases follow the pinned archive's material IDs, even after a save renumbers slots.
  if (withFilaments.filaments) {
    withFilaments = {
      ...withFilaments,
      filaments: withBaseMaterialReferences(
        withFilaments.filaments,
        settings?.projectFilaments.map((filament) => filament.projectFilamentId) ?? [],
        current.baseFilamentIds
      )
    }
  }
  // The desired list writes slots 1..N; scene assignments still speak session IDs until here.
  if (settings?.desiredFilaments && settings.projectFilaments.length > 0) {
    const remap = buildSessionFilamentIdRemap(
      settings.projectFilaments.map((filament) => filament.projectFilamentId)
    )
    if (remap) withFilaments = rebaseSceneEditFilamentIds(withFilaments, remap)
  }

  // The saver and slicer reuse these captures instead of rendering thumbnails themselves.
  const thumbnails = options?.thumbnails
  return thumbnails && thumbnails.length > 0
    ? { ...withFilaments, plateThumbnails: thumbnails }
    : withFilaments
}
