import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOAST_EDGE_GAP, TOAST_STACK_PLACEMENT } from './toastPlacement.js'

test('a phone anchors toasts to the top, clear of the notch', () => {
  assert.equal(TOAST_STACK_PLACEMENT.top.xs, `calc(var(--app-top-inset, 0px) + ${TOAST_EDGE_GAP}px)`)
  assert.equal(TOAST_STACK_PLACEMENT.bottom.xs, 'auto')
})

test('desktop keeps the bottom-right corner', () => {
  assert.equal(TOAST_STACK_PLACEMENT.bottom.sm, `calc(var(--app-safe-bottom, 0px) + ${TOAST_EDGE_GAP}px)`)
  assert.equal(TOAST_STACK_PLACEMENT.top.sm, 'auto')
})

test('every breakpoint names both edges', () => {
  // MUI emits the `xs` entry as `@media (min-width:0px)`, which still matches at desktop widths, so
  // an edge left unset at `sm` keeps the phone's value instead of falling back to `auto`. Dropping
  // either `auto` here silently pins the stack to both edges and stretches it down the viewport.
  for (const edge of [TOAST_STACK_PLACEMENT.top, TOAST_STACK_PLACEMENT.bottom]) {
    assert.equal(Object.keys(edge).sort().join(','), 'sm,xs')
  }
})
