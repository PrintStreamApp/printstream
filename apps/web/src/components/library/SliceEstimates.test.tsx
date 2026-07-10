import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SlicingMetadata } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

// Joy does SSR detection at import time, so load @mui/joy and the component under
// test only after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, render } = await import('@testing-library/react')
const { SliceEstimates } = await import('./SliceEstimates')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function renderEstimates(metadata: SlicingMetadata, filamentMappings?: Parameters<typeof SliceEstimates>[0]['filamentMappings']) {
  return render(
    <CssVarsProvider>
      <SliceEstimates metadata={metadata} filamentMappings={filamentMappings} />
    </CssVarsProvider>
  )
}

test('renders the reported estimates', () => {
  const view = renderEstimates({
    estimatedPrintTimeSeconds: 3661,
    estimatedFilamentWeightGrams: 12.34,
    estimatedFilamentCost: 0.5
  })
  assert.ok(view.getByText('Estimated print time'))
  assert.ok(view.getByText('12.3 g'))
  assert.ok(view.getByText('$0.50'))
})

test('falls back to a notice when the slicer reported no usage estimates', () => {
  const view = renderEstimates({})
  assert.ok(view.getByText(/did not report usage estimates/i))
})

test('shows a per-material breakdown only when more than one material is used', () => {
  const single = renderEstimates({
    estimatedFilamentWeightGrams: 5,
    materials: [{ id: 1, type: 'PLA', weightGrams: 5 }]
  })
  assert.equal(single.queryByText('Per material'), null)
  cleanup()

  const multi = renderEstimates(
    {
      estimatedFilamentWeightGrams: 8,
      materials: [
        { id: 1, weightGrams: 5 },
        { id: 2, weightGrams: 3 }
      ]
    },
    [{ projectFilamentId: 1, material: 'Matte Black', color: '#111', source: 'manual' }]
  )
  assert.ok(multi.getByText('Per material'))
  // Row 1 is enriched from the mapping; row 2 has no mapping, so it falls back to a label.
  assert.ok(multi.getByText('Matte Black'))
  assert.ok(multi.getByText('Material 2'))
})
