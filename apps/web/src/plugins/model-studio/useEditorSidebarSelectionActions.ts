/**
 * Adapts sidebar object and part rows to the editor's shared selection state.
 * Row context menus preserve an existing bulk selection and select an unrelated
 * row before opening, matching viewport context menus.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ContextMenuAnchor } from './contextMenuChrome'
import type { GizmoMode } from './editorGeometry'
import { selectEditorPart } from './lib/editorPartSelectionAction'
import type { EditorPlate, EditorState } from './lib/editorModel'
import { partRowMenuSelection, rangeSlice, type PartMember, type PartRef, type PartSelection } from './lib/selectionModel'
import type { useEditorContextMenuSession } from './useEditorContextMenuSession'

interface SidebarSelectionActionOptions {
  activePlateRef: MutableRefObject<EditorPlate | null>
  stateRef: MutableRefObject<EditorState | null>
  selectedKeyRef: MutableRefObject<string | null>
  objectAnchorKeyRef: MutableRefObject<string | null>
  partAnchorRef: MutableRefObject<PartRef | null>
  partSelectionRef: MutableRefObject<PartSelection | null>
  gizmoPartRef: MutableRefObject<PartRef | null>
  gizmoModeRef: MutableRefObject<GizmoMode>
  allSelectedKeysRef: MutableRefObject<() => string[]>
  selectExclusive: (key: string | null) => void
  toggleAdditiveSelection: (key: string) => void
  setSelectedKey: Dispatch<SetStateAction<string | null>>
  setExtraSelectedKeys: Dispatch<SetStateAction<readonly string[]>>
  setPartSelection: Dispatch<SetStateAction<PartSelection | null>>
  setGizmoPart: Dispatch<SetStateAction<PartRef | null>>
  setGizmoMode: Dispatch<SetStateAction<GizmoMode>>
  setContextMenu: ReturnType<typeof useEditorContextMenuSession>['setContextMenu']
}

/** Return the selection and menu handlers consumed by the editor's object list. */
export function useEditorSidebarSelectionActions(options: SidebarSelectionActionOptions) {
  const {
    activePlateRef,
    stateRef,
    selectedKeyRef,
    objectAnchorKeyRef,
    partAnchorRef,
    partSelectionRef,
    gizmoPartRef,
    gizmoModeRef,
    allSelectedKeysRef,
    selectExclusive,
    toggleAdditiveSelection,
    setSelectedKey,
    setExtraSelectedKeys,
    setPartSelection,
    setGizmoPart,
    setGizmoMode,
    setContextMenu
  } = options

  const handleSelect = useCallback((key: string, modifiers?: { additive?: boolean; range?: boolean }) => {
    if (modifiers?.range) {
      // The last plain or additive click stays primary while Shift selects the contiguous run.
      const ordered = activePlateRef.current?.instances.map((instance) => instance.key) ?? []
      const [primary, ...rest] = rangeSlice(ordered, objectAnchorKeyRef.current, key)
      setSelectedKey(primary ?? key)
      setExtraSelectedKeys(rest)
      setPartSelection((current) => (current ? null : current))
      return
    }
    if (modifiers?.additive) {
      toggleAdditiveSelection(key)
      return
    }
    if (selectedKeyRef.current === key) selectExclusive(null)
    else selectExclusive(key)
  }, [activePlateRef, objectAnchorKeyRef, selectedKeyRef, setSelectedKey, setExtraSelectedKeys,
    setPartSelection, toggleAdditiveSelection, selectExclusive])

  const handleSelectPart = useCallback((
    objectId: number,
    member: PartMember,
    modifiers: { additive: boolean; range: boolean },
    instanceKey: string,
    partOptions?: { keepTool?: boolean }
  ) => {
    selectEditorPart({
      objectId,
      member,
      modifiers,
      instanceKey,
      keepTool: partOptions?.keepTool,
      stateRef,
      gizmoPartRef,
      selectedKeyRef,
      partAnchorRef,
      gizmoModeRef,
      selectExclusive,
      setGizmoPart,
      setSelectedKey,
      setExtraSelectedKeys,
      setPartSelection,
      setGizmoMode
    })
  }, [stateRef, gizmoPartRef, selectedKeyRef, partAnchorRef, gizmoModeRef, selectExclusive,
    setGizmoPart, setSelectedKey, setExtraSelectedKeys, setPartSelection, setGizmoMode])

  const handleObjectRowContextMenu = useCallback((key: string, position: ContextMenuAnchor) => {
    if (!allSelectedKeysRef.current().includes(key)) selectExclusive(key)
    setContextMenu({ ...position, kind: 'object', key })
  }, [allSelectedKeysRef, selectExclusive, setContextMenu])

  const handlePartRowContextMenu = useCallback((
    objectId: number,
    member: PartMember,
    position: ContextMenuAnchor,
    instanceKey: string
  ) => {
    const { selectFirst, members } = partRowMenuSelection(
      { objectId, member },
      partSelectionRef.current,
      gizmoPartRef.current,
      selectedKeyRef.current,
      instanceKey
    )
    // React applies the selection later, so use the menu's synchronous target list.
    if (selectFirst) handleSelectPart(objectId, member, { additive: false, range: false }, instanceKey, { keepTool: true })
    setContextMenu({ ...position, kind: 'parts', objectId, members: [...members] })
  }, [partSelectionRef, gizmoPartRef, selectedKeyRef, handleSelectPart, setContextMenu])

  const handleAddedPartContextMenu = useCallback((
    objectId: number,
    partKey: string,
    position: ContextMenuAnchor,
    instanceKey: string
  ) => {
    // Preserve the complete anchor, including `align`, for touch-accessible row menus.
    handlePartRowContextMenu(objectId, { kind: 'added', key: partKey }, position, instanceKey)
  }, [handlePartRowContextMenu])

  return {
    handleSelect,
    handleSelectPart,
    handleObjectRowContextMenu,
    handlePartRowContextMenu,
    handleAddedPartContextMenu
  }
}
