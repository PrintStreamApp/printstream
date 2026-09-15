import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, render, screen } = await import('@testing-library/react')
const { GcodeScrubberValueChip } = await import('./GcodeScrubberValueChip')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

test('reserves the widest scrubber value without exposing duplicate text', () => {
  const { container } = render(React.createElement(GcodeScrubberValueChip, {
    value: '2/4333',
    widthReference: '4333/4333'
  }))

  assert.ok(screen.getByText('2/4333'))
  const reference = container.querySelector('[aria-hidden="true"]')
  assert.equal(reference?.textContent, '4333/4333')
  assert.equal(reference?.getAttribute('aria-hidden'), 'true')
  assert.equal(dom.window.getComputedStyle(reference!).visibility, 'hidden')
  assert.equal(dom.window.getComputedStyle(reference!.parentElement!).display, 'grid')
})

test('sideways values keep physical space before and after the text', () => {
  render(React.createElement(GcodeScrubberValueChip, {
    value: '100/100',
    widthReference: '100/100',
    sideways: true
  }))

  const chip = screen.getAllByText('100/100')[0]!.closest('.MuiChip-root')!
  const style = dom.window.getComputedStyle(chip)
  assert.equal(style.paddingTop, '4px')
  assert.equal(style.paddingBottom, '4px')
})
