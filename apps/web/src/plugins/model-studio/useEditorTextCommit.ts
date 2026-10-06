/**
 * Owns the Text tool's create/update commit, debounced form sync, and user-font loading.
 * EditorView owns the pinned session refs and scene; hosted and standalone commits keep their
 * existing focused modules. A session chooses its host once, so a later selection change cannot
 * quietly turn hosted text into a second standalone object or make standalone text its own child.
 */
import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import * as THREE from 'three'
import { toast } from '../../lib/toast'
import type { GizmoMode } from './editorGeometry'
import { commitHostedText, type HostedTextCommitOptions } from './lib/editorHostedTextCommit'
import type { EditorImportStore } from './lib/editorImportStore'
import { addedPartHostId, type EditorState } from './lib/editorModel'
import { commitStandaloneText, type StandaloneTextCommitOptions } from './lib/editorStandaloneTextCommit'
import { loadUserFont, type TextFontFace } from './lib/textFonts'
import { textToolValuesEqual, type TextToolValue } from './lib/textToolValue'
import type { PartRef } from './lib/selectionModel'

interface TextCommitOptions {
  mode: GizmoMode
  value: TextToolValue
  stateRef: { current: EditorState | null }
  activePlateIndex: number
  hostKeyRef: { current: string | null }
  selectedKeyRef: { current: string | null }
  editingObjectKeyRef: { current: string | null }
  groupByKeyRef: { current: Map<string, THREE.Group> }
  editingPartKey: string | null
  pointedRef: { current: HostedTextCommitOptions['pointed'] }
  promotingRef: HostedTextCommitOptions['promotingRef']
  loadedValueRef: { current: TextToolValue | null }
  resolveFace: StandaloneTextCommitOptions['resolveFace']
  buildPlacement: HostedTextCommitOptions['buildPlacement']
  importStore: EditorImportStore
  footprintCenterForRef: { current: StandaloneTextCommitOptions['footprintCenterFor'] | null }
  setEditingObject: StandaloneTextCommitOptions['setEditingObject']
  selectObject: StandaloneTextCommitOptions['selectObject']
  previousSelectedKeyRef: StandaloneTextCommitOptions['previousSelectedKeyRef']
  updatePlates: StandaloneTextCommitOptions['updatePlates']
  addInstance: StandaloneTextCommitOptions['addInstance']
  setEditingPartKey: HostedTextCommitOptions['setEditingPartKey']
  setEditingHost: HostedTextCommitOptions['setEditingHost']
  setGizmoPart: Dispatch<SetStateAction<PartRef | null>>
  setState: HostedTextCommitOptions['setState']
  refreshAddedPartMeshes: HostedTextCommitOptions['refreshAddedPartMeshes']
  regenerateThumbnailRef: { current: (() => void) | null }
  setUserFaces: Dispatch<SetStateAction<TextFontFace[]>>
  setValue: Dispatch<SetStateAction<TextToolValue>>
}

/** Keep one live Text session in sync with its panel and uploaded font files. */
export function useEditorTextCommit(options: TextCommitOptions) {
  const {
    mode, value, stateRef, activePlateIndex, hostKeyRef, selectedKeyRef, editingObjectKeyRef,
    groupByKeyRef, editingPartKey, pointedRef, promotingRef, loadedValueRef, resolveFace,
    buildPlacement, importStore, footprintCenterForRef, setEditingObject, selectObject,
    previousSelectedKeyRef, updatePlates, addInstance, setEditingPartKey, setEditingHost,
    setGizmoPart, setState, refreshAddedPartMeshes, regenerateThumbnailRef,
    setUserFaces, setValue
  } = options

  /** Write the form into its pinned standalone object or hosted part. */
  const applyTextPart = useCallback(async () => {
    const state = stateRef.current
    const key = hostKeyRef.current ?? selectedKeyRef.current
    const plate = state?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = key ? groupByKeyRef.current.get(key) : null

    if (!state || editingObjectKeyRef.current != null || !instance || !group) {
      if (!state || !plate) return
      await commitStandaloneText({
        plate,
        activePlateIndex,
        editingObjectKey: editingObjectKeyRef.current,
        value,
        resolveFace,
        importStore,
        footprintCenterFor: (instanceKey) => footprintCenterForRef.current?.(instanceKey) ?? null,
        setEditingObject,
        selectObject,
        previousSelectedKeyRef,
        updatePlates,
        addInstance
      })
      return
    }

    const hostId = addedPartHostId(instance)
    if (hostId == null) {
      toast.error('This model cannot take text yet.')
      return
    }
    await commitHostedText({
      stateRef,
      instance,
      group,
      hostId,
      editingPartKey,
      pointed: pointedRef.current,
      promotingRef,
      value,
      buildPlacement,
      importStore,
      setEditingPartKey,
      setEditingHost,
      selectAddedPart: (objectId, partKey) => {
        setGizmoPart({ objectId, member: { kind: 'added', key: partKey } })
      },
      clearSelectedPart: () => setGizmoPart(null),
      setState,
      refreshAddedPartMeshes,
      regenerateThumbnail: () => { regenerateThumbnailRef.current?.() }
    })
  }, [activePlateIndex, addInstance, buildPlacement, editingPartKey,
    editingObjectKeyRef, footprintCenterForRef, groupByKeyRef, hostKeyRef, importStore,
    pointedRef, previousSelectedKeyRef, promotingRef, refreshAddedPartMeshes,
    regenerateThumbnailRef, resolveFace, selectedKeyRef, selectObject, setGizmoPart,
    setEditingHost, setEditingObject, setEditingPartKey, setState, stateRef, updatePlates, value])

  useEffect(() => {
    if (mode !== 'text') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled) return
      // Loading a saved record is not an edit. Compare its value rather than swallowing the next
      // callback, which might be the user's first real Placement or Operation change.
      const loaded = loadedValueRef.current
      loadedValueRef.current = null
      if (loaded && textToolValuesEqual(loaded, value)) return
      void applyTextPart().catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Unable to update the text.')
      })
    }, 200)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [mode, applyTextPart, value, loadedValueRef])

  /** Register a picked font and select it; a read failure keeps the current face. */
  const loadTextFontFile = useCallback(async (file: File) => {
    try {
      const face = await loadUserFont(file)
      setUserFaces((current) => [...current.filter((entry) => entry.id !== face.id), face])
      setValue((current) => ({ ...current, family: face.family, bold: false, italic: false }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That file could not be read as a font.')
    }
  }, [setUserFaces, setValue])

  return { applyTextPart, loadTextFontFile }
}
