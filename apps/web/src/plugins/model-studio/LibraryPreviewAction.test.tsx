import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { Menu } from '@mui/joy'
import { CssVarsProvider } from '@mui/joy/styles'
import { cleanup, fireEvent, render } from '@testing-library/react'
import React from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { LibraryPreviewAction } from './LibraryPreviewAction'

const dom = installJsdomGlobals()

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

test('renders a plate-preview menu item with an icon and opens the in-page preview flow', () => {
  let actionCount = 0
  let previewCount = 0
  const view = renderAction('gcode', () => {
    actionCount += 1
  }, () => {
    previewCount += 1
  })

  const menuLabel = view.getByText('Preview')

  fireEvent.click(menuLabel)

  assert.equal(actionCount, 1)
  assert.equal(previewCount, 1)
  assert.equal(view.getByTestId('location').textContent, '/workspaces/acme/library')
})

test('renders the shared preview label for stl files', () => {
  const view = renderAction('stl', undefined, () => {})

  assert.ok(view.getByText('Preview'))
})

test('does not render a preview action for unsupported file kinds', () => {
  const view = renderAction('other')

  assert.equal(view.queryByText(/3D/i), null)
  assert.equal(view.getByTestId('location').textContent, '/workspaces/acme/library')
})

function renderAction(kind: string, onAction?: () => void, onPreview?: () => void) {
  return render(
    <CssVarsProvider>
      <MemoryRouter initialEntries={['/workspaces/acme/library']}>
        <Routes>
          <Route
            path="/workspaces/:tenantSlug/*"
            element={(
              <>
                <Menu open>
                  <LibraryPreviewAction fileId="file-1" kind={kind} onAction={onAction} onPreview={onPreview} />
                </Menu>
                <LocationProbe />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>
    </CssVarsProvider>
  )
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}