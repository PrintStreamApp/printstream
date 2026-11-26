import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'
import { shouldShowLibraryPlateTypeTags } from '../lib/libraryFileTags'
import { getMeshThumbnailProvider, registerMeshThumbnailProvider } from '../lib/modelThumbnailRegistry'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { FileThumbnail, LibraryBrowser, LIBRARY_DRAG_MIME, type LibraryDragItem } from './LibraryBrowser'
import { PaginatedLibraryBrowser } from './library/PaginatedLibraryBrowser'
import type { LibraryGroupBy } from '../lib/libraryDirectory'

const dom = installJsdomGlobals()
const originalMeshProvider = getMeshThumbnailProvider()

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
  projectFilamentChips: [],
  favorite: false,
  printCount: 0,
  lastPrintedAt: null
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
  registerMeshThumbnailProvider(originalMeshProvider)
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

test('FileThumbnail for an STL file serves the persisted server thumbnail, rendering on the client only on a miss', async () => {
  const stlFile: LibraryFile = { ...bridgeBackedFile, id: 'file-stl', name: 'widget.stl', kind: 'stl' }
  // A registered client renderer stands in for the model-studio plugin's Three.js path.
  let rendered = 0
  registerMeshThumbnailProvider(async () => { rendered += 1; return 'data:image/png;base64,Zm9v' })

  const view = render(
    <CssVarsProvider>
      <FileThumbnail file={stlFile} size={56} />
    </CssVarsProvider>
  )

  // The thumbnail is served from the server (the warm path), not rendered up front.
  const img = view.getByRole('img', { name: stlFile.name })
  assert.match(img.getAttribute('src') ?? '', /\/api\/library\/file-stl\/thumbnail/)
  assert.equal(rendered, 0)

  // On a cache miss the server thumbnail 404s; the client render is the cold-start fallback.
  fireEvent.error(img)
  await waitFor(() => {
    assert.equal(view.getByRole('img', { name: stlFile.name }).getAttribute('src'), 'data:image/png;base64,Zm9v')
  })
  assert.equal(rendered, 1)
})

test('shouldShowLibraryPlateTypeTags keeps plate chips on gcode AND unsliced 3MF files', () => {
  // Unsliced projects carry their configured bed type, so they get the chip too.
  assert.equal(shouldShowLibraryPlateTypeTags(bridgeBackedFile), true)
  assert.equal(shouldShowLibraryPlateTypeTags(unslicedThreeMfFile), true)
  assert.equal(shouldShowLibraryPlateTypeTags({ ...unslicedThreeMfFile, kind: 'stl' }), false)
})

for (const viewMode of ['icon', 'list'] as const) {
  for (const group of ['none', 'fileType', 'letter', 'dateAdded'] satisfies LibraryGroupBy[]) {
    test(`LibraryBrowser moves a file into a folder in ${viewMode} view grouped by ${group}`, () => {
      const folder: LibraryFolder = { id: 'destination', name: 'Destination', parentId: null }
      const moves: Array<{ item: LibraryDragItem; target: LibraryFolder }> = []
      const sort = { key: 'name', dir: 'asc' } as const
      const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, gcTime: Infinity } } })
      const view = render(
        <CssVarsProvider>
          <QueryClientProvider client={queryClient}>
            <PaginatedLibraryBrowser
              group={group}
              sort={sort}
              filteredFolders={[folder]}
              filteredFiles={[bridgeBackedFile]}
              filteredItemCount={2}
              pagedFolders={[folder]}
              pagedFiles={[bridgeBackedFile]}
              pagination={{ showingLabel: '2 items', currentPage: 1, pageCount: 1, onPageChange() {} }}
              renderBrowser={(folders, files) => (
                <LibraryBrowser
                  folders={folders}
                  files={files}
                  viewMode={viewMode}
                  sort={sort}
                  onFolderOpen={() => {}}
                  onItemDrop={(item, target) => moves.push({ item, target })}
                />
              )}
            />
          </QueryClientProvider>
        </CssVarsProvider>
      )
      const source = view.getByRole('img', { name: bridgeBackedFile.name }).closest('[draggable="true"]')!
      const target = view.getByText(folder.name).closest('[draggable="true"]')!
      const payloads = new Map<string, string>()
      let protectedMode = false
      const dataTransfer = {
        effectAllowed: 'none',
        dropEffect: 'none',
        get types() { return [...payloads.keys()] },
        setData(type: string, value: string) { payloads.set(type, value) },
        // Real browsers hide payload contents until drop, but expose MIME types during dragover.
        getData(type: string) { return protectedMode ? '' : payloads.get(type) ?? '' }
      }

      assert.equal(fireEvent.dragOver(target, { dataTransfer: { types: ['Files'], dropEffect: 'none' } }), true,
        'OS file uploads must not be accepted as library moves')

      fireEvent.dragStart(source, { dataTransfer })
      assert.ok(payloads.has(LIBRARY_DRAG_MIME))
      protectedMode = true
      const accepted = !fireEvent.dragOver(target, { dataTransfer })
      assert.equal(accepted, true, 'folder must accept dragover so the browser permits a drop')
      assert.equal(dataTransfer.dropEffect, 'move')
      protectedMode = false
      fireEvent.drop(target, { dataTransfer })
      assert.deepEqual(moves, [{ item: { type: 'file', file: bridgeBackedFile }, target: folder }])
      fireEvent.dragEnd(source, { dataTransfer })

      fireEvent.dragStart(target, { dataTransfer })
      assert.equal(fireEvent.dragOver(target, { dataTransfer }), true, 'a folder cannot accept itself')
      fireEvent.drop(target, { dataTransfer })
      assert.equal(moves.length, 1)
      fireEvent.dragEnd(target, { dataTransfer })
    })
  }
}
