import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { cleanup, render } from '@testing-library/react'
import React from 'react'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { PrinterJobProgressBlock } from './PrinterJobProgressBlock'
import type { ProgressBarMarker } from './ProgressBarMarkers'

const dom = installJsdomGlobals()

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

const MARKERS: ProgressBarMarker[] = [
  { key: 'pause-1', percent: 18, label: 'Pause at layer 20, 2h away' },
  { key: 'pause-2', percent: 88, label: 'Pause at layer 140, 30m away' }
]

function renderBlock(props: { value: number | null; markers?: readonly ProgressBarMarker[] }) {
  return render(
    <CssVarsProvider>
      <PrinterJobProgressBlock header={null} color="primary" {...props} />
    </CssVarsProvider>
  )
}

function markerElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="progress-bar-marker"]'))
}

test('draws one mark per pause, each labelled for hover', () => {
  const { container } = renderBlock({ value: 40, markers: MARKERS })

  assert.deepEqual(
    markerElements(container).map((element) => element.getAttribute('data-marker-label')),
    ['Pause at layer 20, 2h away', 'Pause at layer 140, 30m away']
  )
})

test('places each mark at its own percent along the track', () => {
  const { container } = renderBlock({ value: 40, markers: MARKERS })

  // `- 1px` is what lands a mark on the fill's leading edge rather than 1px past it.
  assert.deepEqual(
    markerElements(container).map((element) => dom.window.getComputedStyle(element).left),
    ['calc(18% - 1px)', 'calc(88% - 1px)']
  )
})

test('marks sit inside the bar, not on top of it', () => {
  // They must be children of the Joy LinearProgress root, which is the `position: relative` box
  // the fill is a pseudo-element of. Rendering them as a sibling would put them next to the bar
  // instead of over it.
  const { container } = renderBlock({ value: 40, markers: MARKERS })
  const bar = container.querySelector('[role="progressbar"]')

  assert.ok(bar)
  assert.equal(markerElements(container).every((element) => bar.contains(element)), true)
})

test('draws no marks while the bar is indeterminate', () => {
  // A mark is a position on a scale, and an indeterminate bar is not showing one: Joy reuses
  // `value` as the moving segment's WIDTH there, so any mark would point at nothing.
  const { container } = renderBlock({ value: null, markers: MARKERS })

  assert.equal(markerElements(container).length, 0)
})

test('adds nothing to the DOM when a surface passes no marks', () => {
  const withNone = renderBlock({ value: 40, markers: [] })
  assert.equal(markerElements(withNone.container).length, 0)
  cleanup()

  const withUndefined = renderBlock({ value: 40 })
  assert.equal(markerElements(withUndefined.container).length, 0)
})

test('marks are hidden from assistive tech rather than claiming a label that cannot reach it', () => {
  // Joy's bar root is `role="progressbar"`, whose children ARIA defines as presentational, so any
  // label in here is dropped from the accessibility tree anyway. Joy's own `Tooltip` puts an
  // `aria-label` on each child and we cannot stop it, so the marker LAYER is `aria-hidden`, which
  // removes the whole subtree and makes the outcome honest. The readout beside the bar is what
  // actually carries the pauses to a screen reader.
  const { container } = renderBlock({ value: 40, markers: MARKERS })

  const layer = container.querySelector('[aria-hidden="true"]')
  assert.ok(layer, 'the marker layer should be aria-hidden')
  assert.equal(markerElements(container).length, 2)
  assert.equal(markerElements(container).every((element) => layer.contains(element)), true)
})
