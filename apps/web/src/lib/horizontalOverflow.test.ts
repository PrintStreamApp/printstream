import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveHorizontalOverflowState } from './horizontalOverflow'

test('resolveHorizontalOverflowState hides fades when content fits', () => {
  assert.deepEqual(
    resolveHorizontalOverflowState({
      scrollLeft: 0,
      clientWidth: 320,
      scrollWidth: 320
    }),
    {
      isOverflowing: false,
      showStartFade: false,
      showEndFade: false
    }
  )
})

test('resolveHorizontalOverflowState shows the trailing fade at the scroll start', () => {
  assert.deepEqual(
    resolveHorizontalOverflowState({
      scrollLeft: 0,
      clientWidth: 320,
      scrollWidth: 480
    }),
    {
      isOverflowing: true,
      showStartFade: false,
      showEndFade: true
    }
  )
})

test('resolveHorizontalOverflowState shows the leading fade once scrolled and hides the trailing fade at the end', () => {
  assert.deepEqual(
    resolveHorizontalOverflowState({
      scrollLeft: 160,
      clientWidth: 320,
      scrollWidth: 480
    }),
    {
      isOverflowing: true,
      showStartFade: true,
      showEndFade: false
    }
  )
})