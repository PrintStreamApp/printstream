import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import React from 'react'
import type { LibraryFile } from '@printstream/shared'
import { shouldShowLibraryPlateTypeTags } from '../lib/libraryFileTags'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { FileThumbnail } from './LibraryBrowser'

const dom = installJsdomGlobals()

const bridgeBackedFile: LibraryFile = {
  id: 'file-1',
  name: 'alpha-benchy.gcode.3mf',
  sizeBytes: 100,
  uploadedAt: '2026-05-01T00:00:00.000Z',
  kind: 'gcode',
  thumbnailPath: null,
  folderId: null,
  compatiblePrinterModels: [],
  plateTypeChips: [],
  nozzleSizeChips: [],
  projectFilamentChips: []
}

const unslicedThreeMfFile: LibraryFile = {
  ...bridgeBackedFile,
  id: 'file-2',
  name: 'alpha-benchy.3mf',
  kind: '3mf',
  plateTypeChips: ['Textured PEI Plate']
}

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

test('FileThumbnail retries after thumbnails are re-enabled', async () => {
  const view = render(
    <CssVarsProvider>
      <FileThumbnail file={bridgeBackedFile} size={56} />
    </CssVarsProvider>
  )

  fireEvent.error(view.getByRole('img', { name: bridgeBackedFile.name }))
  assert.equal(view.queryByRole('img', { name: bridgeBackedFile.name }), null)
  assert.ok(view.getByText(/gcode/i))

  view.rerender(
    <CssVarsProvider>
      <FileThumbnail file={bridgeBackedFile} size={56} disabled />
    </CssVarsProvider>
  )

  view.rerender(
    <CssVarsProvider>
      <FileThumbnail file={bridgeBackedFile} size={56} />
    </CssVarsProvider>
  )

  await waitFor(() => {
    assert.ok(view.getByRole('img', { name: bridgeBackedFile.name }))
  })
})

test('shouldShowLibraryPlateTypeTags keeps plate chips on gcode AND unsliced 3MF files', () => {
  // Unsliced projects carry their configured bed type, so they get the chip too.
  assert.equal(shouldShowLibraryPlateTypeTags(bridgeBackedFile), true)
  assert.equal(shouldShowLibraryPlateTypeTags(unslicedThreeMfFile), true)
  assert.equal(shouldShowLibraryPlateTypeTags({ ...unslicedThreeMfFile, kind: 'stl' }), false)
})