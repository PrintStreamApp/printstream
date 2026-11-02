import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(0), 0)
dom.window.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, render } = await import('@testing-library/react')
const { PrinterCardAttentionSummary } = await import('./PrinterCardAttentionSummary')
const { getPrinterAttentionSummary } = await import('../../lib/printerProgressSummary')
const { formatPrinterAttentionSummaryText } = await import('../../lib/printersViewHelpers')

afterEach(() => cleanup())
after(() => dom.window.close())

test('an intentional pause renders its reason in warning tone without a Clear error button', () => {
  const summary = getPrinterAttentionSummary({
    stage: 'paused',
    deviceError: { code: '03008013', message: 'Task paused due to the pause command added to the file.' },
    hmsErrors: []
  })
  assert.ok(summary)
  const text = formatPrinterAttentionSummaryText(summary)
  const view = render(
    <CssVarsProvider>
      <PrinterCardAttentionSummary
        summary={summary}
        text={text}
        observeRef={React.createRef<HTMLElement>()}
        clearing={false}
        onClear={() => { assert.fail('An intentional pause must use Resume') }}
      />
    </CssVarsProvider>
  )
  assert.match(text, /0300-8013/)
  assert.equal(dom.window.getComputedStyle(view.getByText(text)).color, 'var(--joy-palette-warning-300)')
  assert.equal(view.queryByRole('button', { name: 'Clear printer error' }), null)
})

test('a real device fault retains danger tone and its Clear error button', () => {
  const summary = getPrinterAttentionSummary({
    stage: 'paused',
    deviceError: { code: '03008010', message: 'The hotend cooling fan speed is abnormal.' },
    hmsErrors: []
  })
  assert.ok(summary)
  const text = formatPrinterAttentionSummaryText(summary)
  const view = render(
    <CssVarsProvider>
      <PrinterCardAttentionSummary
        summary={summary}
        text={text}
        observeRef={React.createRef<HTMLElement>()}
        clearing={false}
        onClear={() => {}}
      />
    </CssVarsProvider>
  )
  assert.equal(dom.window.getComputedStyle(view.getByText(text)).color, 'var(--joy-palette-danger-300)')
  assert.ok(view.getByRole('button', { name: 'Clear printer error' }))
})
