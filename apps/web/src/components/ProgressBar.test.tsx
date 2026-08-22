import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, render } = await import('@testing-library/react')
const { ProgressBar } = await import('./ProgressBar')
const { ProgressSpinner } = await import('./ProgressSpinner')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function renderBar(value?: number | null) {
  const view = render(
    <CssVarsProvider>
      <ProgressBar value={value} />
    </CssVarsProvider>
  )
  return view.getByRole('progressbar')
}

/**
 * The regression this whole component exists for.
 *
 * Joy sizes an indeterminate bar's MOVING SEGMENT from `--LinearProgress-percent`
 * (`progressMinWidth: percent * 1% / 2`, `progressMaxWidth: percent * 1%`), which it
 * takes from the `value` prop. At `0` the segment is zero-width for the whole
 * keyframe cycle, so the animation runs but nothing is drawn — the bar reads as
 * stuck precisely when it is meant to read as busy. Every call site used to write
 * `determinate={x != null} value={x ?? 0}` and hit exactly that.
 */
test('an indeterminate bar leaves Joy to size its segment rather than pinning it to 0%', () => {
  const bar = renderBar(null)

  assert.equal(
    bar.style.getPropertyValue('--LinearProgress-percent'),
    '25',
    'indeterminate bars must keep Joy\'s default segment width; a 0 here draws nothing'
  )
  assert.equal(bar.getAttribute('aria-valuenow'), null, 'an indeterminate bar must not claim a value')
})

test('an omitted value is indeterminate, the same as an explicit null', () => {
  const bar = renderBar(undefined)

  assert.equal(bar.style.getPropertyValue('--LinearProgress-percent'), '25')
  assert.equal(bar.getAttribute('aria-valuenow'), null)
})

test('a determinate bar reports its value to CSS and to assistive tech', () => {
  const bar = renderBar(42)

  assert.equal(bar.style.getPropertyValue('--LinearProgress-percent'), '42')
  assert.equal(bar.getAttribute('aria-valuenow'), '42')
})

test('zero is a real value, not a missing one', () => {
  const bar = renderBar(0)

  assert.equal(bar.style.getPropertyValue('--LinearProgress-percent'), '0')
  assert.equal(bar.getAttribute('aria-valuenow'), '0', 'a genuine 0% is determinate — it has started and reported')
})

test('out-of-range values are clamped so the fill cannot overflow its track', () => {
  assert.equal(renderBar(140).style.getPropertyValue('--LinearProgress-percent'), '100')
  cleanup()
  assert.equal(renderBar(-8).style.getPropertyValue('--LinearProgress-percent'), '0')
})

test('a non-finite value is treated as unknown rather than rendered into CSS', () => {
  const bar = renderBar(Number.NaN)

  assert.equal(bar.style.getPropertyValue('--LinearProgress-percent'), '25')
  assert.equal(bar.getAttribute('aria-valuenow'), null)
})

/** Same defect, same fix, on the circular sibling: at percent 0 the arc has zero length. */
test('an indeterminate spinner leaves Joy to size its arc', () => {
  const view = render(
    <CssVarsProvider>
      <ProgressSpinner value={null} />
    </CssVarsProvider>
  )
  const spinner = view.getByRole('progressbar')

  assert.equal(spinner.style.getPropertyValue('--CircularProgress-percent'), '25')
  assert.equal(spinner.getAttribute('aria-valuenow'), null)
})

test('a determinate spinner reports its value', () => {
  const view = render(
    <CssVarsProvider>
      <ProgressSpinner value={70} />
    </CssVarsProvider>
  )
  const spinner = view.getByRole('progressbar')

  assert.equal(spinner.style.getPropertyValue('--CircularProgress-percent'), '70')
  assert.equal(spinner.getAttribute('aria-valuenow'), '70')
})
