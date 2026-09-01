/**
 * The sticky headers must be OPAQUE, which the scroller's own colour token does not give you.
 *
 * On the glass themes those tokens carry alpha (`background.level1` is `rgba(19, 27, 42, 0.6)`),
 * because they are meant to be layered over the page. Repeating the token on a header therefore
 * left it see-through: scrolling one section's header under another rendered both titles and both
 * action buttons on top of each other. The flat themes, whose tokens are opaque hex, never showed it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { opaqueScrollerBackground, RELATIVE_COLOR_SUPPORTS_QUERY } from './stickySectionBackground'

test('the token is stripped to full opacity, and named as a palette variable', () => {
  const style = opaqueScrollerBackground('background.level1')
  assert.equal(
    style[RELATIVE_COLOR_SUPPORTS_QUERY].backgroundColor,
    'rgb(from var(--joy-palette-background-level1) r g b / 1)'
  )
})

test('the alpha component is explicit, since omitting it inherits the origin alpha', () => {
  // The trap this pins, measured in a browser: `rgb(from <token> r g b)` without `/ 1` returns the
  // token UNCHANGED at 0.6 alpha, so the headers stay transparent and the fix looks applied.
  const style = opaqueScrollerBackground('background.surface')
  assert.match(style[RELATIVE_COLOR_SUPPORTS_QUERY].backgroundColor, /\/ 1\)$/)
})

test('the plain token stays as a fallback', () => {
  // A browser without relative colour syntax drops the unrecognised declaration entirely. Falling
  // back to no background at all would be worse than the translucency it replaces.
  assert.equal(opaqueScrollerBackground('background.level1').bgcolor, 'background.level1')
})

test('every dot in a token path becomes a dash, not just the first', () => {
  assert.match(opaqueScrollerBackground('a.b.c')[RELATIVE_COLOR_SUPPORTS_QUERY].backgroundColor, /--joy-palette-a-b-c\b/)
})
