/**
 * Routes Joy Modal close gestures through the editor's nested Escape policy.
 * Joy stops Escape before window shortcuts see it, while stacked dialogs receive
 * their own event first. The caller supplies current state and the existing
 * selection/tool handlers so this boundary cannot bypass their cleanup.
 */
import type { ComponentProps, MutableRefObject } from 'react'
import type { BackAwareModal } from '../../../components/BackAwareModal'
import { isBackGestureClose } from '../../../components/dialogBackGesture'
import { editorEscapeAction, RESTING_GIZMO_MODE, type GizmoMode } from '../editorGeometry'
import { hasEditorSelection, type PartRef, type PartSelection } from './selectionModel'

type ModalCloseHandler = NonNullable<ComponentProps<typeof BackAwareModal>['onClose']>

interface EditorModalCloseOptions {
  suppressEscapeRef: MutableRefObject<boolean>
  contextMenuOpenRef: MutableRefObject<boolean>
  closeContextMenu: () => void
  mode: GizmoMode
  measurePickCount: number
  removeLastMeasurePick: () => void
  selectedKey: string | null
  partSelection: PartSelection | null
  gizmoPart: PartRef | null
  changeMode: (mode: GizmoMode) => void
  clearSelection: () => void
  requestClose: (source: string) => void | Promise<void>
}

/** Apply one close gesture, peeling the innermost tool or selection first. */
export function routeEditorModalClose(
  event: Parameters<ModalCloseHandler>[0],
  reason: Parameters<ModalCloseHandler>[1],
  options: EditorModalCloseOptions
): void {
  if (reason !== 'escapeKeyDown') {
    // Back and X both arrive as closeClick. Preserve the gesture in duplicate-close diagnostics.
    void options.requestClose(`dialog:${isBackGestureClose(event) ? 'back' : reason}`)
    return
  }

  // Right-click dispatches a synthetic Escape to dismiss Joy menus, not to back out of the editor.
  if (options.suppressEscapeRef.current) return
  if (options.contextMenuOpenRef.current) {
    options.closeContextMenu()
    return
  }

  // A measurement is staged one pick at a time before its tool exits.
  if (options.mode === 'measure' && options.measurePickCount > 0) {
    options.removeLastMeasurePick()
    return
  }

  const action = editorEscapeAction(options.mode, hasEditorSelection({
    objectKey: options.selectedKey,
    partSelection: options.partSelection,
    gizmoPart: options.gizmoPart
  }))
  if (action === 'reset-tool') {
    options.changeMode(RESTING_GIZMO_MODE)
    return
  }
  if (action === 'clear-selection') {
    options.clearSelection()
    return
  }
  void options.requestClose('escape')
}
