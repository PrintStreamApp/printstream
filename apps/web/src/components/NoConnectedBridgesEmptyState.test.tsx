import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { cleanup, fireEvent, render } from '@testing-library/react'
import React from 'react'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { NoConnectedBridgesEmptyState } from './NoConnectedBridgesEmptyState'

const dom = installJsdomGlobals()

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

test('NoConnectedBridgesEmptyState offers a bridges CTA when settings can be opened', () => {
  let opened = false
  const view = render(
    <CssVarsProvider>
      <NoConnectedBridgesEmptyState
        title="Connect a bridge to add printers"
        description="Open Bridges in Settings to connect a bridge, then come back here to add and monitor printers."
        canOpenBridgesSettings
        onOpenBridgesSettings={() => {
          opened = true
        }}
      />
    </CssVarsProvider>
  )

  fireEvent.click(view.getByRole('button', { name: 'Open bridges' }))

  assert.equal(opened, true)
  assert.equal(view.queryByText('A workspace manager can connect one in Settings > Bridges.'), null)
})

test('NoConnectedBridgesEmptyState points read-only users to a workspace manager', () => {
  const view = render(
    <CssVarsProvider>
      <NoConnectedBridgesEmptyState
        title="Connect a bridge to use the library"
        description="Connect a bridge in Settings to browse printer-local files and send prints from the library."
      />
    </CssVarsProvider>
  )

  assert.equal(view.queryByRole('button', { name: 'Open bridges' }), null)
  assert.equal(view.getByText(/A workspace manager can connect one in Settings > Bridges\./).textContent?.includes('A workspace manager can connect one in Settings > Bridges.'), true)
})