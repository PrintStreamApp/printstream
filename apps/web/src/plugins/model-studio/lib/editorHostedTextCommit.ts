/**
 * Owns hosted Text's staged part create and replacement, including promotion of a saved baked
 * part. The editor supplies the pinned host and live callbacks; this module keeps the session's
 * part mutation, removal safety decision, and mesh refresh in one place.
 */
import type { Dispatch, SetStateAction } from 'react'
import * as THREE from 'three'
import { toast } from '../../../lib/toast'
import type { TextToolValue } from './textToolValue'
import type { EditorImportStore } from './editorImportStore'
import { stageAddedPartGeometry } from './addedParts'
import { textAnchorForEdit } from './textPlacement'
import { createAddedTextPart, textInfoForTool, updateAddedTextPart } from './textAuthoring'
import { decomposeThreeMfPartTransform } from './threeMfPartTransform'
import { triangleSoupsEqual } from './meshCut'
import {
  nextInstanceKey,
  withRemovedParts,
  type EditorInstance,
  type EditorState
} from './editorModel'

type TextPlacement = NonNullable<ReturnType<typeof import('./textPlacement').buildTextPlacement>>

export interface HostedTextCommitOptions {
  stateRef: { current: EditorState | null }
  instance: EditorInstance
  group: THREE.Group
  hostId: number
  editingPartKey: string | null
  pointed: { point: THREE.Vector3; normal: THREE.Vector3 } | null
  promotingRef: { current: { hostId: number; partIndex: number; transform: number[] } | null }
  value: TextToolValue
  buildPlacement: (
    group: THREE.Group,
    anchor: THREE.Vector3 | null,
    normal: THREE.Vector3 | null
  ) => Promise<TextPlacement | null>
  importStore: EditorImportStore
  setEditingPartKey: (key: string | null) => void
  setEditingHost: (key: string | null) => void
  selectAddedPart: (hostId: number, partKey: string) => void
  clearSelectedPart: () => void
  setState: Dispatch<SetStateAction<EditorState | null>>
  refreshAddedPartMeshes: () => void
  regenerateThumbnail: () => void
}

/** Apply one live hosted text rebuild after staging any changed geometry. */
export async function commitHostedText(options: HostedTextCommitOptions): Promise<void> {
  const state = options.stateRef.current
  if (!state) return

  // The pointed face wins; otherwise retain the current added or baked part's own world anchor.
  const promotingFrom = options.promotingRef.current
  const anchor = textAnchorForEdit(
    options.group,
    options.pointed?.point ?? null,
    options.editingPartKey,
    promotingFrom?.partIndex ?? null
  )
  const placement = await options.buildPlacement(options.group, anchor, options.pointed?.normal ?? null)
  if (!placement) return

  const parts = state.addedParts?.[options.hostId] ?? []
  const existing = options.editingPartKey
    ? parts.find((part) => part.key === options.editingPartKey)
    : null
  // A flat drag changes only pose. Reuse the import id instead of staging identical soup again.
  const unchanged = existing?.importId != null && existing.soup != null
    && triangleSoupsEqual(existing.soup, placement.soup)
  const staged = unchanged
    ? { importId: existing.importId }
    : await stageAddedPartGeometry(
      options.importStore,
      { kind: 'soup', soup: placement.soup, name: options.value.text.slice(0, 40) },
      0
    )
  const textInfo = textInfoForTool(options.value, placement.face, {
    standalone: false,
    hit: options.pointed
  })

  if (existing) {
    updateAddedTextPart({
      part: existing,
      importId: staged.importId,
      placement,
      value: options.value,
      textInfo,
      pointed: Boolean(options.pointed)
    })
  } else {
    const partKey = nextInstanceKey()
    // A saved part has a complete placement. Recomputing from its centre would lift text by half
    // its thickness on every re-edit, so retain that matrix until the pointer chooses a new face.
    const keptPlacement = !options.pointed && promotingFrom
      ? decomposeThreeMfPartTransform(promotingFrom.transform)
      : null
    const created = createAddedTextPart({
      key: partKey,
      importId: staged.importId,
      placement,
      keptPlacement,
      value: options.value,
      textInfo,
      filamentId: options.instance.filamentId
    })
    // Store only after staging succeeds. A rejected file must not create an empty addedParts entry.
    if (!state.addedParts) state.addedParts = {}
    if (!state.addedParts[options.hostId]) state.addedParts[options.hostId] = parts
    parts.push(created)
    options.setEditingPartKey(partKey)
    options.setEditingHost(options.instance.key)
    options.selectAddedPart(options.hostId, partKey)

    // Promotion consumes the baked volume exactly once. A refusal removes the candidate and its
    // selection, preserving the original rather than leaving two parts for one text edit.
    options.promotingRef.current = null
    if (promotingFrom && options.hostId === promotingFrom.hostId) {
      const removed = withRemovedParts(state, promotingFrom.hostId, new Set([promotingFrom.partIndex]))
      if (removed) {
        options.setState((current) => current
          ? withRemovedParts(current, promotingFrom.hostId, new Set([promotingFrom.partIndex])) ?? current
          : current)
      } else {
        parts.pop()
        options.setEditingPartKey(null)
        options.clearSelectedPart()
        toast.error('This object would have nothing left to print. Change the operation back to Join, or add another part first.')
      }
    }
  }

  options.refreshAddedPartMeshes()
  options.regenerateThumbnail()
}
