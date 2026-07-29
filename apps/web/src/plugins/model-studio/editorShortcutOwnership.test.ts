/**
 * Guards the rule in this plugin'the s development notes: `useEditorKeyboardShortcuts` owns the editor's
 * shortcuts, and `EditorView` must not handle the same keys in a listener of its own.
 *
 * This is a source scan because the failure is invisible at runtime: both listeners are attached to
 * `window`, so neither shadows the other and `preventDefault` does not stop the sibling — the action
 * simply runs TWICE. That shipped: every Ctrl+Z undid two steps, which is how a save-then-undo
 * looked like it had lost the restored material when it had actually restored and then undone again.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const editorView = readFileSync(path.join(here, 'EditorView.tsx'), 'utf8')

/** Keys the shortcut hook owns; EditorView handling any of them again doubles the action. */
const OWNED_BY_THE_HOOK: Array<{ label: string; pattern: RegExp }> = [
  { label: 'undo/redo (Ctrl+Z / Ctrl+Y)', pattern: /event\.key === '[zyZY]'/ },
  { label: 'delete (Delete / Backspace)', pattern: /case 'Delete':/ }
]

test('EditorView does not re-handle keys the shortcut hook owns', () => {
  for (const { label, pattern } of OWNED_BY_THE_HOOK) {
    assert.equal(
      pattern.test(editorView),
      false,
      `EditorView handles ${label} in its own keydown listener; the hook already does, so the action fires twice`
    )
  }
})
