import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { LibraryBrowseResponse, LibraryFile, LibraryFolder } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

// ScrollableDialogBody (the picker's scroll container) measures overflow via rAF,
// which jsdom does not provide.
const animationFrameWindow = dom.window as unknown as {
  requestAnimationFrame: (callback: () => void) => number
  cancelAnimationFrame: (handle: number) => void
}
animationFrameWindow.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0) as unknown as number
animationFrameWindow.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)

// Nothing here should reach the network: every query key the picker uses is seeded
// below. A throwing stub turns an unseeded key into a clear failure instead of a hang.
globalThis.fetch = async () => {
  throw new Error('unexpected fetch: the test should seed every query key')
}

// Joy's Modal does SSR detection at import time, so load @mui/joy and the component
// under test only after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { LibraryPickerModal } = await import('./LibraryPickerModal')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

const dragonsFolder: LibraryFolder = { id: 'folder-dragons', name: 'Dragons', parentId: null }

function makeFile(id: string, name: string, folderId: string | null): LibraryFile {
  return {
    id,
    name,
    sizeBytes: 100,
    uploadedAt: '2026-05-01T00:00:00.000Z',
    kind: 'gcode',
    thumbnailPath: null,
    folderId,
    compatiblePrinterModels: [],
    plateTypeChips: [],
    nozzleSizeChips: [],
    projectFilamentChips: [],
    favorite: false,
    printCount: 0,
    lastPrintedAt: null
  }
}

function browsePayload(folders: LibraryFolder[], files: LibraryFile[]): LibraryBrowseResponse {
  return {
    mode: 'flat',
    readOnly: false,
    activeBridgeId: null,
    bridgeEntries: [],
    folders,
    files,
    truncated: false,
    fileLimit: null
  }
}

function renderPicker() {
  // gcTime must be Infinity: react-query is imported after the jsdom globals exist, so
  // it runs in browser mode and its default 5-minute cache-GC timer is a ref'd
  // setTimeout that would keep the process alive past the runner's per-test timeout.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } }
  })
  // Keys mirror LibraryPickerModal's browse/folders queries. The empty string is
  // `allFolderSearch`, which stays empty while the search scope is "This folder".
  queryClient.setQueryData<LibraryBrowseResponse>(
    ['library-browse', 'printer-picker', 'root', 'none', '', false],
    browsePayload([dragonsFolder], [makeFile('file-ship', 'ship-hull.gcode.3mf', null)])
  )
  queryClient.setQueryData<LibraryBrowseResponse>(
    ['library-browse', 'printer-picker', dragonsFolder.id, 'none', '', false],
    browsePayload([], [makeFile('file-castle', 'castle-tower.gcode.3mf', dragonsFolder.id)])
  )
  queryClient.setQueryData<{ folders: LibraryFolder[] }>(
    ['library-folders', 'printer-picker', 'none'],
    { folders: [dragonsFolder] }
  )
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider>
        <LibraryPickerModal canSlice={false} onPick={() => {}} onClose={() => {}} />
      </CssVarsProvider>
    </QueryClientProvider>
  )
}

// Regression: a search term left standing after opening a folder made the folder
// unreachable — the term kept filtering the destination's children, so a folder that
// matched only by name opened onto an apparently empty listing.
test('opening a folder found by search clears the search and shows the folder contents', async () => {
  const view = renderPicker()

  const searchInput = await view.findByLabelText('Search print library')
  fireEvent.change(searchInput, { target: { value: 'dragon' } })

  // The term filters the current folder client-side: the folder matches by name, the
  // sibling file does not.
  await waitFor(() => {
    assert.equal(view.queryByText(/ship-hull/), null)
  })
  const folderRow = view.getByRole('button', { name: /Dragons/ })

  fireEvent.click(folderRow)

  await waitFor(() => {
    assert.ok(view.getByText(/castle-tower/), 'folder contents should render after opening it')
  })
  assert.equal((searchInput as HTMLInputElement).value, '')
})
