import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SlicingProfileSummary } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

// Joy does SSR detection at import time, so load @mui/joy and the component
// under test only after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { SlicingProfileAutocomplete } = await import('./SlicingProfileAutocomplete')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function buildProfile(id: string, name: string, source: 'builtin' | 'custom'): SlicingProfileSummary {
  return { id, source, kind: 'process', name }
}

const PROFILES = [
  buildProfile('custom:a', '0.20mm Standard @BBL H2D - Ryan', 'custom'),
  buildProfile('builtin:1', '0.20mm Standard @BBL H2D', 'builtin'),
  buildProfile('builtin:2', '0.16mm Balanced Quality @BBL H2D', 'builtin')
]

test('opening with a committed (modified) selection lists the FULL catalog, not just the chosen option', () => {
  // Regression: the controlled input carries the selected display name — with the '* '
  // modified marker it no longer equals the option label, so the default filter narrowed the
  // open list to the chosen option and the rest of the catalog was unreachable without
  // clearing the field first.
  render(
    <CssVarsProvider>
      <SlicingProfileAutocomplete
        profiles={PROFILES}
        value={PROFILES[0]!}
        modified
        placeholder="Process profile"
        onChange={() => {}}
      />
    </CssVarsProvider>
  )
  const input = screen.getByPlaceholderText('Process profile') as HTMLInputElement
  assert.equal(input.value, '* 0.20mm Standard @BBL H2D - Ryan')

  fireEvent.focus(input)
  fireEvent.mouseDown(input)

  const options = screen.getAllByRole('option')
  assert.equal(options.length, PROFILES.length, 'every profile must be listed on open')
})

test('typing still filters the catalog', () => {
  render(
    <CssVarsProvider>
      <SlicingProfileAutocomplete
        profiles={PROFILES}
        value={PROFILES[0]!}
        placeholder="Process profile"
        onChange={() => {}}
      />
    </CssVarsProvider>
  )
  const input = screen.getByPlaceholderText('Process profile') as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.mouseDown(input)
  fireEvent.change(input, { target: { value: '0.16mm' } })

  const options = screen.getAllByRole('option')
  assert.equal(options.length, 1)
  assert.match(options[0]!.textContent ?? '', /0\.16mm Balanced Quality/)
})
