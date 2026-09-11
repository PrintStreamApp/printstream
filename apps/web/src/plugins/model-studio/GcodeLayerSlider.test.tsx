import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { GCODE_LAYER_EVENT_HIT_SIZE_PX, GcodeLayerSlider } = await import('./GcodeLayerSlider')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

test('event markers keep compact glyphs inside keyboard-focusable pointer targets', () => {
  const selected: number[] = []
  render(React.createElement(GcodeLayerSlider, {
    layerCount: 5,
    value: 4,
    markers: [{
      layer: 2,
      z: 0.6,
      pauseCount: 1,
      filamentChanges: [{ filamentId: 2, color: '#12ab34' }]
    }],
    onChange: (layer: number) => selected.push(layer)
  }))

  assert.ok(GCODE_LAYER_EVENT_HIT_SIZE_PX >= 24)
  const change = screen.getByRole('button', { name: /Filament change to material 2/ })
  const pause = screen.getByRole('button', { name: /Pause at layer 3/ })
  assert.equal(dom.window.getComputedStyle(change).width, `${GCODE_LAYER_EVENT_HIT_SIZE_PX}px`)
  assert.equal(dom.window.getComputedStyle(pause).height, `${GCODE_LAYER_EVENT_HIT_SIZE_PX}px`)

  change.focus()
  assert.equal(dom.window.document.activeElement, change)
  fireEvent.click(change)
  fireEvent.click(pause)
  assert.deepEqual(selected, [2, 2])

  const emittedCss = [...dom.window.document.styleSheets]
    .flatMap((sheet) => [...(sheet.cssRules ?? [])])
    .map((rule) => rule.cssText)
    .join('\n')
  assert.match(emittedCss, /focus-visible/)
  assert.match(emittedCss, /outline:\s*2px solid var\(--joy-palette-focusVisible\)/)
})
