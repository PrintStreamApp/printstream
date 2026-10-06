/**
 * Routes editor tool openings that need a session, rather than only a gizmo mode. Text and SVG
 * reopen authored parts; Layers requires an object. EditorView supplies the live selection and
 * panel setters while this module owns the transition order and history policy.
 */
import { canonicalThreeMfPartSubtype, type SceneEditPartSubtype } from '@printstream/shared'
import type { SvgPartRecord } from '@printstream/shared/three-mf'
import type { Vector3 } from 'three'
import type { GizmoMode } from '../editorGeometry'
import type { EditorAddedPart, EditorPlate } from './editorModel'
import type { BakedAuthoredPart } from './editorAuthoredPartLookup'
import { resolveEditorTextSession } from './editorTextSession'
import type { TextToolValue } from './textToolValue'

export interface ToolModeChangeOptions {
  mode: GizmoMode
  selectedKey: string | null
  selectedBakedPart: { objectId: number; partIndex: number } | null
  selectedAddedPartKey: string | null
  activePlateRef: { current: EditorPlate | null | undefined }
  reeditBakedPartRef: { current: { hostId: number; partIndex: number; transform: number[] } | null }
  editingTextSurfaceRef: { current: { point: Vector3; normal: Vector3 } | null }
  textApplyLoadedRef: { current: TextToolValue | null }
  textTool: TextToolValue
  openLayerHeightFor: (key: string) => void
  findBakedAuthoredPart: (objectId: number, partIndex: number) => BakedAuthoredPart | null
  findAddedSvgPart: (key: string) => { part: EditorAddedPart; hostId: number } | null
  findAddedTextPart: (key: string) => { part: EditorAddedPart; hostInstanceKey: string } | null
  reopenSvgArtwork: (record: SvgPartRecord, hostId: number, operation: SceneEditPartSubtype) => Promise<void>
  clearSvgReedit: () => void
  recordHistory: () => void
  setTextTool: (value: TextToolValue) => void
  setEditingTextPartKey: (key: string | null) => void
  setEditingTextHost: (key: string | null) => void
  setEditingTextObject: (key: string | null) => void
  setGizmoMode: (mode: GizmoMode) => void
}

/**
 * Open a tool from the rail. A stale baked-text promotion is cleared before every early return,
 * including Layers and SVG; only reopening that exact baked part may set it again.
 */
export function changeEditorToolMode(options: ToolModeChangeOptions): void {
  const {
    mode, selectedKey, selectedBakedPart, selectedAddedPartKey, activePlateRef,
    reeditBakedPartRef, editingTextSurfaceRef, textApplyLoadedRef, textTool
  } = options

  reeditBakedPartRef.current = null
  if (mode === 'layerHeight') {
    if (selectedKey) options.openLayerHeightFor(selectedKey)
    return
  }

  if (mode === 'svg') {
    const bakedSvg = selectedBakedPart
      ? options.findBakedAuthoredPart(selectedBakedPart.objectId, selectedBakedPart.partIndex)
      : null
    const addedSvg = selectedAddedPartKey ? options.findAddedSvgPart(selectedAddedPartKey) : null
    const record = bakedSvg?.part.svgPart ?? addedSvg?.part.svgPart ?? null
    const hostId = bakedSvg?.hostId ?? addedSvg?.hostId ?? null
    if (record && hostId != null) {
      // Looking at saved settings changes nothing. The later SVG commit owns its history step.
      void options.reopenSvgArtwork(record, hostId, canonicalThreeMfPartSubtype(
        bakedSvg?.part.subtype ?? addedSvg?.part.subtype ?? null
      ))
      options.setGizmoMode(mode)
      return
    }
    options.clearSvgReedit()
  }

  if (mode === 'text') {
    // One checkpoint covers the live rebuild session, not one step per text keystroke.
    options.recordHistory()
    const selectedInstance = selectedKey
      ? activePlateRef.current?.instances.find((entry) => entry.key === selectedKey) ?? null
      : null
    const baked = selectedBakedPart
      ? options.findBakedAuthoredPart(selectedBakedPart.objectId, selectedBakedPart.partIndex)
      : null
    const added = selectedAddedPartKey ? options.findAddedTextPart(selectedAddedPartKey) : null
    const session = resolveEditorTextSession({ current: textTool, selectedInstance, baked, added })

    if (session.kind === 'standalone') {
      options.setTextTool(session.value)
      options.setEditingTextPartKey(null)
      options.setEditingTextHost(null)
      editingTextSurfaceRef.current = null
      options.setEditingTextObject(session.objectKey)
      textApplyLoadedRef.current = session.value
      options.setGizmoMode(mode)
      return
    }
    if (session.kind === 'baked') {
      options.setTextTool(session.value)
      textApplyLoadedRef.current = session.value
      options.setEditingTextPartKey(null)
      options.setEditingTextHost(session.hostKey)
      editingTextSurfaceRef.current = null
      reeditBakedPartRef.current = {
        hostId: session.hostId,
        partIndex: session.partIndex,
        transform: session.transform
      }
      options.setEditingTextObject(null)
      options.setGizmoMode(mode)
      return
    }
    if (session.kind === 'added') {
      options.setTextTool(session.value)
      textApplyLoadedRef.current = session.value
      options.setEditingTextPartKey(session.partKey)
      options.setEditingTextHost(session.hostKey)
      // The saved surface hit can be stale after moving the part or rotating its host.
      editingTextSurfaceRef.current = null
    } else {
      options.setEditingTextPartKey(null)
      options.setTextTool(session.value)
      options.setEditingTextHost(null)
      editingTextSurfaceRef.current = null
    }
    options.setEditingTextObject(null)
  }

  options.setGizmoMode(mode)
}
