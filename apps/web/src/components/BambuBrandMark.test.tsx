/**
 * The vendor-prefix substitution, pinned because it is easy to make too eager.
 *
 * BambuStudio replaces the token "Bambu" with its mark anywhere in a filament item; our names are
 * literal preset names rather than its shortened labels, so the same rule applied blindly would
 * badge a POLYMAKER preset with Bambu's logo (their names carry "@Bambu Lab <printer>"). Leading
 * token only.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, render } = await import('@testing-library/react')
const { PresetNameWithBrandMark } = await import('./BambuBrandMark')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

function renderName(name: string) {
  const { container } = render(React.createElement(PresetNameWithBrandMark, { name }))
  return {
    text: (container.textContent ?? '').trim(),
    marks: container.querySelectorAll('svg').length
  }
}

test('a leading Bambu token becomes the mark, and the rest of the name survives verbatim', () => {
  const result = renderName('Bambu PLA Basic @BBL P1S 0.4 nozzle')
  assert.equal(result.marks, 1)
  assert.equal(result.text, 'PLA Basic @BBL P1S 0.4 nozzle')
})

test('a user preset built on a Bambu one is substituted the same way', () => {
  const result = renderName('Bambu PLA Basic - Custom - No AUX - 50')
  assert.equal(result.marks, 1)
  assert.equal(result.text, 'PLA Basic - Custom - No AUX - 50')
})

test('another vendor keeps its name, mark and all, even when the printer is a Bambu one', () => {
  // The regression this file exists for: the token appears MID-STRING here, naming the machine the
  // preset targets rather than the filament's maker. Substituting it would put Bambu's mark on
  // Polymaker's product.
  const result = renderName('Polymaker PLA Panchroma PLA @Bambu Lab P1S 0.4 nozzle')
  assert.equal(result.marks, 0)
  assert.equal(result.text, 'Polymaker PLA Panchroma PLA @Bambu Lab P1S 0.4 nozzle')
})

test('a non-Bambu name renders unchanged with no mark', () => {
  const result = renderName('Generic PLA')
  assert.equal(result.marks, 0)
  assert.equal(result.text, 'Generic PLA')
})

test('a name that merely starts with the letters, not the token, is left alone', () => {
  // "Bambusa" would otherwise lose its first six characters to a logo.
  const result = renderName('Bambusa PLA')
  assert.equal(result.marks, 0)
  assert.equal(result.text, 'Bambusa PLA')
})
