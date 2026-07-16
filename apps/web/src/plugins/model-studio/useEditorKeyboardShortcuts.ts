/**
 * Global keyboard shortcuts for the 3MF project editor, BambuStudio-style.
 *
 * Owns ONE window `keydown` listener for the editor's viewport/list actions so the shortcut set
 * lives in one place instead of scattered handlers, and so `EditorView` (already large) stays lean.
 * Every action is a callback supplied by `EditorView`; this hook only decides which fires for a key.
 *
 * Contract:
 * - It never fires while the user is typing: events whose target is an input/textarea/select or a
 *   contentEditable element (the transform number fields, rename prompt, slice settings, …) pass
 *   through untouched. Callers that open their own modal/menu keep working because those trap focus.
 * - It reads live state through the passed refs, so the listener is installed once and never sees a
 *   stale selection/plate.
 * - Shortcuts that shadow a browser default (Ctrl/Cmd+C/X/V/D/A/Z/Y) call `preventDefault` only when
 *   they actually act on a selection, so an editor with nothing selected still yields normal browser
 *   copy/select-all.
 *
 * Copy/cut/paste operate on an in-memory object clipboard held here (deep-cloned instance snapshots),
 * so paste survives a cut or a delete and repeats — matching BambuStudio, not the OS clipboard.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import { duplicateInstance, type EditorInstance, type EditorPlate } from './lib/editorModel'
import type { GizmoMode } from './editorGeometry'

/** True when the keystroke is being typed into a field and must not trigger a shortcut. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export interface EditorKeyboardShortcutsInput {
  /** Whether shortcuts are live (the editor is open and not in a read-only/preview mode). */
  enabledRef: MutableRefObject<boolean>
  /** The primary selected instance key, or null. */
  selectedKeyRef: MutableRefObject<string | null>
  /** The active plate (for select-all / paste target / clipboard reads). */
  activePlateRef: MutableRefObject<EditorPlate | null>
  /** Duplicate the selection (whole multi-selection when the key is a member). */
  onDuplicate: (key: string) => void
  /** Delete the selection (whole multi-selection when the key is a member). */
  onDelete: (key: string) => void
  /** Select every instance on the active plate. */
  onSelectAll: () => void
  /** Clear the selection. */
  onClearSelection: () => void
  /** Add instances (already positioned at free spots) to the active plate, as one undoable step. */
  onPasteInstances: (instances: EditorInstance[]) => void
  /** All instance keys currently in the selection (primary + extras), for copy/cut. */
  selectionKeysRef: MutableRefObject<string[]>
  undoRef: MutableRefObject<() => void>
  redoRef: MutableRefObject<() => void>
  setGizmoModeRef: MutableRefObject<(mode: GizmoMode) => void>
}

export function useEditorKeyboardShortcuts(input: EditorKeyboardShortcutsInput): void {
  // The clipboard is snapshot instances (fresh keys), re-cloned on each paste so repeated pastes
  // never collide and a paste after cut/delete still works.
  const clipboardRef = useRef<EditorInstance[]>([])
  // Keep the whole input in a ref so the effect installs the listener exactly once.
  const ref = useRef(input)
  ref.current = input

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const api = ref.current
      if (!api.enabledRef.current) return
      if (isTypingTarget(event.target)) return

      const ctrl = event.ctrlKey || event.metaKey
      const selectedKey = api.selectedKeyRef.current
      const hasSelection = selectedKey != null

      if (ctrl) {
        const key = event.key.toLowerCase()
        switch (key) {
          case 'c':
            if (!hasSelection) return
            event.preventDefault()
            clipboardRef.current = collectSelection(api).map(duplicateInstance)
            return
          case 'x':
            if (!hasSelection) return
            event.preventDefault()
            clipboardRef.current = collectSelection(api).map(duplicateInstance)
            api.onDelete(selectedKey)
            return
          case 'v': {
            if (clipboardRef.current.length === 0) return
            event.preventDefault()
            // Clone again so this paste has its own keys and the clipboard stays reusable.
            api.onPasteInstances(clipboardRef.current.map(duplicateInstance))
            return
          }
          case 'd':
            if (!hasSelection) return
            event.preventDefault()
            api.onDuplicate(selectedKey)
            return
          case 'a':
            event.preventDefault()
            api.onSelectAll()
            return
          case 'z':
            event.preventDefault()
            if (event.shiftKey) api.redoRef.current()
            else api.undoRef.current()
            return
          case 'y':
            event.preventDefault()
            api.redoRef.current()
            return
          default:
            return
        }
      }

      switch (event.key) {
        case 'Delete':
        case 'Backspace':
          if (!hasSelection) return
          event.preventDefault()
          api.onDelete(selectedKey)
          return
        case 'Escape':
          if (!hasSelection) return
          // Do not preventDefault: a dialog/menu may also want Escape to close.
          api.onClearSelection()
          return
        // BambuStudio gizmo shortcuts (only meaningful with a selection).
        case 'm':
        case 'M':
          if (hasSelection) api.setGizmoModeRef.current('translate')
          return
        case 'r':
        case 'R':
          if (hasSelection) api.setGizmoModeRef.current('rotate')
          return
        case 's':
        case 'S':
          if (hasSelection) api.setGizmoModeRef.current('scale')
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

/** The selected instances on the active plate (primary + multi-selection extras). */
function collectSelection(api: EditorKeyboardShortcutsInput): EditorInstance[] {
  const plate = api.activePlateRef.current
  if (!plate) return []
  const keys = new Set(api.selectionKeysRef.current)
  return plate.instances.filter((instance) => keys.has(instance.key))
}
