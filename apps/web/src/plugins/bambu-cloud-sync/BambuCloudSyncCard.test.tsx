/** Exercise the manager and compact badge together so a sync cannot leave either preview stale. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/library' })
const { render, cleanup, fireEvent, waitFor } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { MemoryRouter } = await import('react-router-dom')
const { AppThemeProvider } = await import('../../theme/AppThemeProvider')
const { theme } = await import('../../theme/theme')
const { BambuCloudSyncCard } = await import('./BambuCloudSyncCard')
const { BambuCloudSyncStatus } = await import('./BambuCloudSyncStatus')

const originalFetch = globalThis.fetch
const clients: InstanceType<typeof QueryClient>[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  globalThis.fetch = originalFetch
})
after(() => dom.window.close())

/** Mount the two real consumers against the same workspace-scoped query cache. */
function renderSyncSurfaces() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: 0 } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/workspaces/test/library']}>
        <AppThemeProvider theme={theme}>
          <BambuCloudSyncStatus />
          <BambuCloudSyncCard />
        </AppThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** Serve a connected account plus a preview whose imports change when Sync is pressed. */
function fakeSyncApi(remainingAfterSync: number, discoverDeletion = false) {
  let pullable = 34
  let checks = 0
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path.endsWith('/status')) {
      return Response.json({
        connection: { account: 'user@example.com', region: 'global', status: 'connected', quotaBlockedKinds: [] },
        syncedPresetCount: 43,
        heldPresetCount: 0,
        pendingDeletionConfirmations: discoverDeletion && checks > 0
          ? [{ presetId: 'process-1', name: 'Deleted process', kind: 'process', direction: 'missingRemotely', detectedAt: '' }]
          : []
      })
    }
    if (path.endsWith('/check')) {
      checks += 1
      return Response.json({ connected: true, status: 'connected', pullable, pushable: 0, pending: discoverDeletion ? 1 : 0, held: 0 })
    }
    if (path.endsWith('/sync')) {
      assert.equal(options?.method, 'POST')
      pullable = remainingAfterSync
      return Response.json({ pulled: [], created: [], updated: [], deleted: [], skipped: remainingAfterSync > 0 ? [{ name: 'Unimportable process', kind: 'process', detail: 'No settings returned' }] : [], failed: [], missingRemotely: [], missingLocally: [], route: 'direct' })
    }
    throw new Error(`Unexpected request: ${path}`)
  }
  return { checkCount: () => checks }
}

test('the manager displays available imports and syncing clears its count and the mounted badge', async () => {
  const api = fakeSyncApi(0)
  const view = renderSyncSurfaces()
  await waitFor(() => assert.ok(view.queryByText(/34 preset updates\. 34 to import from Bambu Cloud/)))
  assert.ok(view.queryByRole('button', { name: /34 preset updates/ }))
  assert.equal(api.checkCount(), 1, 'opening the manager shares the badge preview')

  fireEvent.click(view.getByRole('button', { name: 'Sync now' }))
  await waitFor(() => assert.ok(view.queryByText('Presets are up to date.')))
  assert.equal(view.queryByRole('button', { name: /34 preset updates/ }), null)
  assert.equal(view.queryByText(/34 preset updates\. 34 to import/), null)
  assert.equal(api.checkCount(), 2, 'sync refreshes the shared preview once')
})

test('sync retains the actual remaining import count instead of clearing both surfaces unconditionally', async () => {
  fakeSyncApi(2)
  const view = renderSyncSurfaces()
  await waitFor(() => assert.ok(view.queryByText(/34 preset updates\. 34 to import/)))

  fireEvent.click(view.getByRole('button', { name: 'Sync now' }))
  await waitFor(() => assert.ok(view.queryByText(/2 preset updates\. 2 to import from Bambu Cloud/)))
  assert.ok(view.queryByRole('button', { name: /2 preset updates/ }))
  assert.equal(view.queryByText('Presets are up to date.'), null)
  assert.equal(view.queryByText('Everything was already up to date.'), null)
  assert.ok(view.queryByText('No presets were changed.'))
})

test('a manager opened alone shows confirmation controls for deletions discovered by its check', async () => {
  fakeSyncApi(0, true)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  clients.push(client)
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/workspaces/test/library']}>
        <AppThemeProvider theme={theme}>
          <BambuCloudSyncCard />
        </AppThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  await waitFor(() => assert.ok(view.queryByRole('button', { name: 'Delete here too' })))
  assert.ok(view.queryByRole('button', { name: 'Keep as local-only' }))
  assert.ok(view.queryByText(/1 deletion awaiting a decision/))
})
