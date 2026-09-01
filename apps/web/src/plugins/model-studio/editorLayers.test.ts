/**
 * The editor's viewport layers, pinned by ORDER rather than by value.
 *
 * Each number is meaningless alone; what matters is which covers which. All three once shared the
 * tooltip layer, so the winner was DOM order in `EditorView`, and the variable-layer-height bar
 * painted over the tool rail: hovering the rail expanded its labels straight underneath the bar,
 * leaving half of every tool name unreadable.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EDITOR_CHROME_Z_INDEX, EDITOR_POPUP_Z_INDEX, TOOL_PANEL_Z_INDEX } from './editorLayers'

const THEME = { zIndex: { tooltip: 1500 } }

test('the toolbar covers the tool panels, never the other way round', () => {
  // The toolbar is how you leave the tool you are in, so a panel over it is a dead end.
  assert.ok(EDITOR_CHROME_Z_INDEX(THEME) > TOOL_PANEL_Z_INDEX(THEME))
})

test('menus cover the chrome they are opened from', () => {
  // Raising the toolbar without raising these would only move the bug: a right-click near the
  // top-left corner would open its menu underneath the rail.
  assert.ok(EDITOR_POPUP_Z_INDEX(THEME) > EDITOR_CHROME_Z_INDEX(THEME))
})

test('every layer clears the editor modal itself', () => {
  // The editor is a Joy Modal at 1300; anything painted over the canvas has to beat it.
  const MODAL = 1300
  for (const layer of [TOOL_PANEL_Z_INDEX, EDITOR_CHROME_Z_INDEX, EDITOR_POPUP_Z_INDEX]) {
    assert.ok(layer(THEME) > MODAL)
  }
})

test('the layers track the theme rather than being hardcoded', () => {
  // They are offsets from the tooltip layer, so a theme that moves it keeps the whole stack intact.
  const moved = { zIndex: { tooltip: 9000 } }
  assert.ok(TOOL_PANEL_Z_INDEX(moved) >= 9000)
  assert.ok(EDITOR_POPUP_Z_INDEX(moved) > EDITOR_CHROME_Z_INDEX(moved))
})
