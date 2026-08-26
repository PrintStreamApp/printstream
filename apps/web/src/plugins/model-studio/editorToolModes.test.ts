/**
 * Which tool modes survive an empty selection.
 *
 * The editor has one exclusive mode at a time, and most of them drive a panel bound to the SELECTED
 * object while attaching no gizmo. Clear the selection in one of those and the viewport shows
 * nothing at all: no panel, no gizmo, and a rail that renders the tool lit but disabled, so the only
 * escape is to click an object. Deselecting happens from several places (viewport click, Escape,
 * plate switch, add/remove plate), which is why this is one predicate rather than a line in each.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSelectionOnlyGizmoMode, isTransformGizmoMode, type GizmoMode } from './editorGeometry'

const SELECTION_ONLY: GizmoMode[] = [
  'layFace', 'cut', 'paintSupports', 'paintSeam', 'paintColor', 'paintFuzzy', 'brimEars', 'layerHeight'
]

test('every panel-driven mode is dropped when the selection goes', () => {
  for (const mode of SELECTION_ONLY) {
    assert.equal(isSelectionOnlyGizmoMode(mode), true, `${mode} would strand the editor with no panel`)
  }
})

test('the transform modes and measure survive an empty selection', () => {
  // `translate` is the resting state, so falling back to it must not itself trigger a fallback;
  // `measure` genuinely works with nothing selected.
  for (const mode of ['translate', 'rotate', 'scale', 'measure'] as GizmoMode[]) {
    assert.equal(isSelectionOnlyGizmoMode(mode), false, `${mode} would be reset out from under the user`)
  }
})

test('the two mode predicates never both claim a mode', () => {
  // A transform mode attaches the gizmo, so by construction it is not one of the panel-only modes.
  for (const mode of SELECTION_ONLY) {
    assert.equal(isTransformGizmoMode(mode), false, `${mode} claims to attach the gizmo AND to need a panel`)
  }
})

test('text is exempt from the selection-only rule, because it works with nothing selected', () => {
  // Text with no selection adds its OWN model, which is the only way to letter a plate that has no
  // host. Without the exemption, opening the tool on an empty selection bounced straight back to
  // Move and the tool appeared to close itself the moment it opened.
  assert.equal(isSelectionOnlyGizmoMode('text'), false)
  // Its neighbours in the same toolbar group stay selection-only, so the exemption is not a blanket.
  assert.equal(isSelectionOnlyGizmoMode('layFace'), true)
  assert.equal(isSelectionOnlyGizmoMode('brimEars'), true)
})
