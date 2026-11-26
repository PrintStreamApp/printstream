import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/alpha/library' })
// The scrollable destination dialog measures layout on the window's animation frame.
dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 0)
dom.window.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)
const React = (await import('react')).default
const { act, cleanup, fireEvent, render, renderHook, screen, waitFor } = await import('@testing-library/react')
const { MenuList } = await import('@mui/joy')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { MemoryRouter, Route, Routes, useLocation } = await import('react-router-dom')
const { LibraryImportMenuAction } = await import('./ImportMenuActions')
const { useLibraryImportLaunch, closeLibraryImport, openLibraryImport } = await import('./importLaunchStore')
const { useImportDestination } = await import('./useImportDestination')
const { PromptDialogProvider } = await import('../../components/PromptDialogProvider')
const { LibraryImportOverlayHost } = await import('./LibraryImportOverlayHost')
const { useRemoteImportsController } = await import('./useRemoteImportsController')
const { LibraryDestinationDialog } = await import('../../components/LibraryDestinationDialog')
const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  closeLibraryImport()
  globalThis.fetch = originalFetch
  delete (window as unknown as { PrintStreamDesktop?: unknown }).PrintStreamDesktop
})
after(() => { dom.window.close() })

test('Upload exposes each source directly and retains its folder after the menu unmounts', () => {
  const { result } = renderHook(useLibraryImportLaunch)
  const menu = render(<MenuList><LibraryImportMenuAction bridgeId="bridge-1" folderId="folder-1" /></MenuList>)
  assert.deepEqual(screen.getAllByRole('menuitem').map((item) => item.textContent), ['MakerWorld', 'Printables', 'From URL'])
  fireEvent.click(screen.getByRole('menuitem', { name: 'MakerWorld' }))
  menu.unmount()
  assert.deepEqual(result.current, { source: 'makerworld', bridgeId: 'bridge-1', folderId: 'folder-1', workspaceSlug: undefined })
})

test('a save cannot bypass replacement consent while the existing-file listing is pending', async () => {
  let release!: (response: Response) => void
  globalThis.fetch = () => new Promise((resolve) => { release = resolve })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  let saves = 0
  const view = render(<QueryClientProvider client={client}><PromptDialogProvider>
    <LibraryDestinationDialog title="Save model" description="Choose a folder" showFiles
      initialFolderId={null} folders={[]} bridgeId="bridge" bridgeName="Home" showRoot={false}
      fileNameField={{ label: 'File name', initialValue: 'Chosen', extension: '.gcode.3mf' }}
      submitting={false} error={null} onClose={() => {}} onSubmit={() => { saves += 1 }} confirmActionLabel={() => 'Save here'} />
  </PromptDialogProvider></QueryClientProvider>)
  assert.equal(screen.getByRole('button', { name: 'Save here' }).hasAttribute('disabled'), true)
  fireEvent.keyDown(screen.getByLabelText('File name'), { key: 'Enter' })
  assert.equal(saves, 0)
  release(new Response(JSON.stringify({ files: [{ id: 'old', name: 'Chosen.gcode.3mf', kind: '3mf', sizeBytes: 100, uploadedAt: '2026-10-22T12:00:00Z', thumbnailPath: null, folderId: null, compatiblePrinterModels: [], plateTypeChips: [], nozzleSizeChips: [], projectFilamentChips: [], favorite: false, printCount: 0, lastPrintedAt: null }] }), { headers: { 'Content-Type': 'application/json' } }))
  await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Save here' }).hasAttribute('disabled'), false))
  fireEvent.click(screen.getByRole('button', { name: 'Save here' }))
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Replace file' })))
  assert.equal(saves, 0)
  view.unmount()
  client.clear()
})

test('a failed destination listing keeps saving disabled and exposes the failure', async () => {
  globalThis.fetch = async () => { throw new Error('offline') }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const view = render(<QueryClientProvider client={client}><PromptDialogProvider>
    <LibraryDestinationDialog title="Save model" description="Choose a folder" showFiles
      initialFolderId={null} folders={[]} bridgeId="bridge" bridgeName="Home" showRoot={false}
      fileNameField={{ label: 'File name', initialValue: 'Chosen', extension: '.stl' }}
      submitting={false} error={null} onClose={() => {}} onSubmit={() => assert.fail('must not save')} confirmActionLabel={() => 'Save here'} />
  </PromptDialogProvider></QueryClientProvider>)
  await waitFor(() => assert.ok(screen.getByText(/Could not load existing files/)))
  assert.equal(screen.getByRole('button', { name: 'Save here' }).hasAttribute('disabled'), true)
  view.unmount()
  client.clear()
})

test('truncated folders require an exact server name check before replacing an omitted file', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost')
    const body = url.pathname.endsWith('/save-conflict')
      ? { file: { id: 'omitted', name: 'Chosen.stl' } }
      : { files: [], truncated: true, fileLimit: 1000 }
    if (url.pathname.endsWith('/save-conflict')) assert.equal(url.searchParams.get('fileName'), 'Chosen.stl')
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  let saves = 0
  const view = render(<QueryClientProvider client={client}><PromptDialogProvider>
    <LibraryDestinationDialog title="Save model" description="Choose a folder" showFiles
      initialFolderId={null} folders={[]} bridgeId="bridge" bridgeName="Home" showRoot={false}
      fileNameField={{ label: 'File name', initialValue: 'Chosen', extension: '.stl' }}
      submitting={false} error={null} onClose={() => {}} onSubmit={() => { saves += 1 }} confirmActionLabel={() => 'Save here'} />
  </PromptDialogProvider></QueryClientProvider>)
  await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Save here' }).hasAttribute('disabled'), false))
  fireEvent.click(screen.getByRole('button', { name: 'Save here' }))
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Replace file' })))
  assert.equal(saves, 0)
  view.unmount()
  client.clear()
})

test('each model needs confirmation; cancellation and unmount resolve without a destination', async () => {
  const { result, unmount } = renderHook(useImportDestination)
  let first!: ReturnType<typeof result.current.choose>
  act(() => { first = result.current.choose('first.3mf') })
  assert.equal(result.current.fileName, 'first.3mf')
  act(() => { result.current.finish(null) })
  assert.equal(await first, null)

  let second!: ReturnType<typeof result.current.choose>
  act(() => { second = result.current.choose('second.3mf') })
  assert.equal(result.current.fileName, 'second.3mf')
  act(() => { result.current.finish({ bridgeId: 'bridge-2', folderId: null }) })
  assert.deepEqual(await second, { bridgeId: 'bridge-2', folderId: null })

  let third!: ReturnType<typeof result.current.choose>
  act(() => { third = result.current.choose('third.3mf') })
  unmount()
  assert.equal(await third, null)
  assert.equal(await result.current.choose('late.3mf'), null)
})

test('URL import makes no write until confirmation and sends the selected root explicitly', async () => {
  const writes: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname
    let body: unknown = {}
    if (path === '/api/library/browse') body = { bridgeEntries: [{ id: 'bridge-1', name: 'Home' }], activeBridgeId: 'bridge-1' }
    if (path === '/api/library/folders') body = { folders: [] }
    if (path.endsWith('/prepare-url')) body = { id: 'prepared-1', fileName: 'actual.gcode.3mf', sizeBytes: 100, expiresAt: '2026-12-01T00:00:00Z' }
    if (path.endsWith('/import-url')) {
      writes.push(JSON.parse(String(init?.body)))
      body = { file: { id: 'saved', name: 'mesh.stl', folderId: null }, canPrintDirectly: false }
    }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } })
  const launch = { source: 'url' as const, bridgeId: 'bridge-1', folderId: 'initial-folder' }
  const { result, unmount } = renderHook(() => useRemoteImportsController(launch), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/workspaces/alpha/library']}>
          <Routes><Route path="/workspaces/:workspaceSlug/library" element={children} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  })
  await waitFor(() => { assert.equal(result.current.selectedBridgeId, 'bridge-1') })
  act(() => { result.current.setUrl('https://downloads.example/mesh.stl') })
  act(() => { result.current.startServerImport(false) })
  await waitFor(() => { assert.equal(result.current.destinationOpen, true) })
  assert.equal(result.current.pickedFolderId, 'initial-folder')
  assert.equal(result.current.destinationPrompt.fileName, 'actual.gcode.3mf')
  assert.equal(writes.length, 0)
  act(() => { result.current.destinationPrompt.finish(null) })
  await waitFor(() => { assert.equal(result.current.importMutation.isPending, false) })
  assert.equal(writes.length, 0)

  act(() => { result.current.startServerImport(false) })
  await waitFor(() => { assert.equal(result.current.destinationOpen, true) })
  act(() => { result.current.destinationPrompt.finish({ bridgeId: 'bridge-2', folderId: null }) })
  await waitFor(() => { assert.equal(result.current.importMutation.isSuccess, true) })
  assert.deepEqual(writes, [{ url: 'https://downloads.example/mesh.stl', bridgeId: 'bridge-2', folderId: null, destinationSelected: true, preparedImportId: 'prepared-1' }])
  unmount()
  client.clear()
})


test('Open confirms a chosen filename replacement and keeps the Model Studio handoff', async () => {
  let saved = false
  const existingFile = {
    id: 'existing', name: 'My chosen model.stl', sizeBytes: 100, uploadedAt: '2026-10-22T12:00:00Z', kind: 'stl',
    thumbnailPath: null, folderId: null, compatiblePrinterModels: [], plateTypeChips: [],
    nozzleSizeChips: [], projectFilamentChips: [], favorite: false, printCount: 0, lastPrintedAt: null
  }
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const body = path === '/api/library/browse'
      ? { bridgeEntries: [{ id: 'initial', name: 'Home' }], activeBridgeId: 'initial', files: [existingFile] }
      : path === '/api/library/folders' ? { folders: [] } : {}
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }
  Object.assign(window, { PrintStreamDesktop: {
    version: 1,
    capabilities: { modelBrowserImport: ['makerworld'], modelImportDestination: true },
    request: async () => {
      const destination = await window.__printstreamChooseModelDestination!('part.stl')
      assert.ok(destination)
      assert.equal(destination.outputFileName, 'My chosen model')
      assert.equal('fileName' in destination && destination.fileName, 'My chosen model.stl')
      saved = true
      return {
        file: {
          id: 'saved', name: 'My chosen model.stl', sizeBytes: 100, uploadedAt: '2026-10-22T12:00:00Z', kind: 'stl',
          thumbnailPath: null, folderId: destination.folderId, compatiblePrinterModels: [], plateTypeChips: [],
          nozzleSizeChips: [], projectFilamentChips: [], favorite: false, printCount: 0, lastPrintedAt: null
        },
        destinationBridgeId: destination.bridgeId,
        openAfterImport: 'model-studio'
      }
    }
  } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } })
  function Host() {
    const route = useLocation()
    return <><LibraryImportOverlayHost /><p data-testid="route">{route.pathname}{route.search}</p></>
  }
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/workspaces/alpha/library']}>
        <PromptDialogProvider><Host /></PromptDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  act(() => { openLibraryImport({ source: 'makerworld', bridgeId: 'initial', folderId: null, workspaceSlug: 'alpha' }) })
  await waitFor(() => { assert.ok(screen.getByRole('button', { name: 'Save here' })) })
  fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'My chosen model' } })
  await waitFor(() => { assert.ok(screen.getByText('My chosen model')) })
  fireEvent.click(screen.getByRole('button', { name: 'Save here' }))
  await waitFor(() => { assert.ok(screen.getByRole('button', { name: 'Replace file' })) })
  assert.equal(saved, false, 'no save before replacement confirmation')
  fireEvent.click(screen.getByRole('button', { name: 'Replace file' }))
  await waitFor(() => {
    assert.equal(screen.getByTestId('route').textContent, '/workspaces/alpha/library?bridge=initial&studioImport=saved')
    assert.equal(screen.queryByRole('dialog'), null)
  })
  view.unmount()
  client.clear()
})
