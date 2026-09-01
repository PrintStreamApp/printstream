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
import { allowsSelectionPicking, editorEscapeAction, isSelectionOnlyGizmoMode, isTransformGizmoMode, RESTING_GIZMO_MODE, type GizmoMode } from './editorGeometry'

const SELECTION_ONLY: GizmoMode[] = [
  'layFace', 'cut', 'meshBoolean', 'paintSupports', 'paintSeam', 'paintColor', 'paintFuzzy',
  'brimEars', 'layerHeight'
]

test('every panel-driven mode is dropped when the selection goes', () => {
  for (const mode of SELECTION_ONLY) {
    assert.equal(isSelectionOnlyGizmoMode(mode), true, `${mode} would strand the editor with no panel`)
  }
})

test('the resting mode, the transform modes and measure survive an empty selection', () => {
  // The resting mode is what the others fall BACK to, so it must not itself trigger a fallback --
  // that would be an infinite reset. `measure` genuinely works with nothing selected.
  for (const mode of [RESTING_GIZMO_MODE, 'translate', 'rotate', 'scale', 'measure'] as GizmoMode[]) {
    assert.equal(isSelectionOnlyGizmoMode(mode), false, `${mode} would be reset out from under the user`)
  }
})

test('the two mode predicates never both claim a mode', () => {
  // A transform mode attaches the gizmo, so by construction it is not one of the panel-only modes.
  for (const mode of SELECTION_ONLY) {
    assert.equal(isTransformGizmoMode(mode), false, `${mode} claims to attach the gizmo AND to need a panel`)
  }
})

test('svg is exempt too, for the same reason as text', () => {
  // Artwork with nothing selected becomes its own object, which is the only way to badge a plate
  // that has no host to attach to. Without the exemption the tool bounces straight back to Select.
  assert.equal(isSelectionOnlyGizmoMode('svg'), false)
  assert.equal(allowsSelectionPicking('svg'), false, 'a click in the tool is not a selection')
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

test('the resting mode is a mode of its own, not one of the transform gizmos', () => {
  // It attaches no gizmo at all: that is the difference from `translate`, which used to be the
  // resting state and so put move arrows on everything the moment it was selected.
  assert.equal(isTransformGizmoMode(RESTING_GIZMO_MODE), false)
  assert.notEqual(RESTING_GIZMO_MODE, 'translate')
})

test('falling back from any selection-only mode lands somewhere that does not fall back again', () => {
  // The reset target is the resting mode; if that were itself selection-only the editor would
  // bounce between modes on every deselect.
  assert.equal(isSelectionOnlyGizmoMode(RESTING_GIZMO_MODE), false)
  for (const mode of SELECTION_ONLY) {
    assert.equal(isSelectionOnlyGizmoMode(mode), true)
  }
})

test('picking works in the resting mode, not just under a transform gizmo', () => {
  // The regression this pins: the part drill-down was gated on translate/rotate/scale spelled out
  // by hand, so once the editor rested in Select, clicking a part inside a selected object silently
  // did nothing -- no error, the click just stopped selecting.
  assert.equal(allowsSelectionPicking(RESTING_GIZMO_MODE), true)
  for (const mode of ['translate', 'rotate', 'scale'] as GizmoMode[]) {
    assert.equal(allowsSelectionPicking(mode), true, `${mode} must still pick`)
  }
})

test('a mode that ACTS on what it is pointed at never doubles as a picker', () => {
  // A click in these is the tool firing (paint a triangle, choose the face to lay flat), so
  // treating it as a selection would both paint AND re-select on every stroke. The boolean is here
  // for a slightly different reason: it acts on the SET rather than on what the cursor is over, so
  // a plain click must not be allowed to quietly collapse that set to one object.
  for (const mode of ['layFace', 'cut', 'meshBoolean', 'paintSupports', 'paintSeam', 'paintColor',
    'paintFuzzy', 'brimEars', 'layerHeight'] as GizmoMode[]) {
    assert.equal(allowsSelectionPicking(mode), false, `${mode} would fire its tool AND re-select`)
  }
})

test('Escape backs out one layer at a time: tool, then selection, then the editor', () => {
  // Studio's gizmo manager gets first refusal and closes the gizmo while KEEPING the selection
  // (`GLGizmosManager.cpp:1132-1142`); only with nothing open does `deselect_all()` run
  // (`GLCanvas3D.cpp:4607`). The third stage is ours: Studio's canvas is a window, ours is a dialog.
  assert.equal(editorEscapeAction('translate', true), 'reset-tool')
  assert.equal(editorEscapeAction(RESTING_GIZMO_MODE, true), 'clear-selection')
  assert.equal(editorEscapeAction(RESTING_GIZMO_MODE, false), 'close')
})

test('a tool that works without a selection is still escapable', () => {
  // `measure` and `text` both run with nothing selected. Ordering the stages selection-first would
  // make Escape a no-op in exactly those two, since there is no selection to clear.
  for (const mode of ['measure', 'text'] as GizmoMode[]) {
    assert.equal(editorEscapeAction(mode, false), 'reset-tool', `${mode} must be escapable`)
  }
})

test('Escape only closes the editor from a bare resting state', () => {
  // The close is the LAST resort: reaching it while a tool or a selection is live is how a stray
  // Escape throws away unsaved work behind a confirm prompt nobody meant to summon.
  for (const mode of ['translate', 'rotate', 'scale', 'cut', 'paintColor', 'measure', 'text'] as GizmoMode[]) {
    assert.notEqual(editorEscapeAction(mode, false), 'close', `${mode} must back out before closing`)
  }
  assert.notEqual(editorEscapeAction(RESTING_GIZMO_MODE, true), 'close')
})
