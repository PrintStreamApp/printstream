/** Exercise the mounted editor snapshot while an explicit catalogue refresh is delayed. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { renderHook, act, cleanup, waitFor } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query')
const React = await import('react')
const { useSlicingPresetsSnapshot } = await import('./useSlicingPresetsSnapshot')
const { useSaveSlicingPreset } = await import('../settings/useSaveSlicingPreset')
const { SlicingPresetsChangedContext } = await import('../settings/useRefreshSlicingPresets')
afterEach(cleanup)
after(() => dom.window.close())

for (const kind of ['machine', 'process', 'filament']) {
  test(`explicit refresh shows a new ${kind} preset without reopening the editor`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
    const key = ['slicing-profiles', 'engine']
    client.setQueryData(key, ['original'])
    let finishFetch: (value: string[]) => void = () => { throw new Error('No pending fetch') }
    let calls = 0
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)
    const view = renderHook(() => {
      const query = useQuery({
        queryKey: key,
        staleTime: Infinity,
        queryFn: () => {
          calls += 1
          return new Promise<string[]>((resolve) => { finishFetch = resolve })
        }
      })
      return useSlicingPresetsSnapshot(query.data!, {
        hold: true, ready: query.data != null, scope: 'engine', refetch: query.refetch
      })
    }, { wrapper })
    // Another user's change reaches React Query but must not disturb this editor.
    act(() => { client.setQueryData(key, ['original', 'background']) })
    await waitFor(() => assert.deepEqual(view.result.current.profiles, ['original']))
    let refresh: unknown
    act(() => { refresh = view.result.current.refresh() })
    await waitFor(() => assert.equal(calls, 1))
    assert.deepEqual(view.result.current.profiles, ['original'])
    await act(async () => {
      finishFetch(['original', `new-${kind}`])
      await refresh
    })
    await waitFor(() => assert.deepEqual(view.result.current.profiles, ['original', `new-${kind}`]))
    assert.equal(view.result.current.revision, 1, 'explicit refresh also releases pinned process baselines')
    act(() => { client.setQueryData(key, ['later-background']) })
    await waitFor(() => assert.deepEqual(client.getQueryData(key), ['later-background']))
    assert.deepEqual(view.result.current.profiles, ['original', `new-${kind}`])
    view.unmount()
    client.clear()
  })
}

for (const kind of ['machine', 'process', 'filament'] as const) {
  test(`saving a ${kind} preset refreshes both the manager and the held editor list without a WebSocket`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
    const previousFetch = globalThis.fetch
    let stored = ['original']
    let failSave = false
    let catalogueReads = 0
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.method, 'POST')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.kind, kind)
      if (failSave) return Response.json({ error: 'Save rejected' }, { status: 400 })
      stored = ['original', `new-${kind}`]
      return Response.json({})
    }
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children)
    const view = renderHook(() => {
      const query = useQuery({
        queryKey: ['slicing-profiles', 'engine'],
        queryFn: async () => { catalogueReads += 1; return stored },
        initialData: stored, staleTime: Infinity
      })
      const manager = useQuery({ queryKey: ['slicing-profiles'], queryFn: async () => stored, initialData: stored, staleTime: Infinity })
      const snapshot = useSlicingPresetsSnapshot(query.data, {
        hold: true, ready: query.data != null, scope: 'engine', refetch: query.refetch
      })
      return { ...snapshot, manager: manager.data, save: useSaveSlicingPreset(snapshot.refresh) }
    }, { wrapper })
    const upload = { kind, name: 'custom', overwrite: false, config: {} }
    try {
      await act(async () => { await view.result.current.save(upload) })
      await waitFor(() => assert.deepEqual(view.result.current.profiles, ['original', `new-${kind}`]))
      assert.deepEqual(view.result.current.manager, ['original', `new-${kind}`])
      assert.equal(catalogueReads, 1, 'the editor joins invalidation rather than fetching the catalogue twice')
      failSave = true
      await act(async () => { await assert.rejects(view.result.current.save(upload), /Save rejected/) })
      assert.deepEqual(view.result.current.profiles, ['original', `new-${kind}`])
      assert.equal(catalogueReads, 1, 'a failed write must not refresh the catalogue')
    } finally {
      view.unmount()
      client.clear()
      globalThis.fetch = previousFetch
    }
  })
}

test('an unsuccessful explicit refresh retains the held catalogue', async () => {
  const props = {
    value: ['original'], hold: true, ready: true, scope: 'engine',
    refetch: async () => ({ isSuccess: false })
  }
  const view = renderHook((p: typeof props) => useSlicingPresetsSnapshot(p.value, p), { initialProps: props })
  view.rerender({ ...props, value: ['background'] })
  await act(async () => { await view.result.current.refresh() })
  assert.deepEqual(view.result.current.profiles, ['original'])
  assert.equal(view.result.current.revision, 0)
})

test('a delayed refresh for a previous engine cannot release the new engine snapshot', async () => {
  let finish: (result: { isSuccess: boolean }) => void = () => { throw new Error('No pending refresh') }
  const props = {
    value: ['A'], hold: true, ready: true, scope: 'a',
    refetch: () => new Promise<{ isSuccess: boolean }>((resolve) => { finish = resolve })
  }
  const view = renderHook((p: typeof props) => useSlicingPresetsSnapshot(p.value, p), { initialProps: props })
  let pending: Promise<void>
  act(() => { pending = view.result.current.refresh() })
  view.rerender({ ...props, value: ['B'], scope: 'b' })
  view.rerender({ ...props, value: ['B background'], scope: 'b' })
  await act(async () => {
    finish({ isSuccess: true })
    await pending
  })
  assert.deepEqual(view.result.current.profiles, ['B'])
  assert.equal(view.result.current.revision, 0)
})

test('mounting with cached presets during a background refetch holds the usable cached list', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  let finish: (value: string[]) => void = () => { throw new Error('No pending query') }
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
  const view = renderHook(() => {
    const query = useQuery({
      queryKey: ['slicing-profiles', 'engine'], initialData: ['cached'], staleTime: 0,
      queryFn: () => new Promise<string[]>((resolve) => { finish = resolve })
    })
    return {
      ...useSlicingPresetsSnapshot(query.data, { hold: true, ready: query.data.length > 0, scope: 'engine', refetch: query.refetch }),
      fetching: query.isFetching
    }
  }, { wrapper })
  try {
    assert.equal(view.result.current.fetching, true)
    assert.deepEqual(view.result.current.profiles, ['cached'])
    await act(async () => { finish(['background change']) })
    await waitFor(() => assert.equal(view.result.current.fetching, false))
    assert.deepEqual(view.result.current.profiles, ['cached'])
    assert.equal(view.result.current.revision, 0)
  } finally {
    view.unmount()
    client.clear()
  }
})

test('an upload finishing after the manager unmounts still refreshes the held editor list', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  const previousFetch = globalThis.fetch
  let stored = ['original']
  let finishUpload: () => void = () => { throw new Error('No pending upload') }
  globalThis.fetch = async () => await new Promise<Response>((resolve) => {
    finishUpload = () => { stored = ['original', 'uploaded']; resolve(Response.json({})) }
  })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
  const editor = renderHook(() => {
    const query = useQuery({ queryKey: ['slicing-profiles', 'engine'], queryFn: async () => stored, initialData: stored, staleTime: Infinity })
    return useSlicingPresetsSnapshot(query.data, { hold: true, ready: query.data.length > 0, scope: 'engine', refetch: query.refetch })
  }, { wrapper })
  const managerWrapper = ({ children }: { children: React.ReactNode }) => wrapper({
    children: React.createElement(SlicingPresetsChangedContext.Provider, { value: editor.result.current.refresh }, children)
  })
  const manager = renderHook(() => useSaveSlicingPreset(), { wrapper: managerWrapper })
  try {
    let upload: Promise<void>
    act(() => { upload = manager.result.current({ kind: 'filament', name: 'late', overwrite: false, config: {} }) })
    manager.unmount()
    // Closing may read the catalogue before the write commits. Its later completion must
    // still be treated as this user's action rather than an unrelated background refresh.
    await act(async () => { await editor.result.current.refresh() })
    assert.deepEqual(editor.result.current.profiles, ['original'])
    await act(async () => { finishUpload(); await upload })
    await waitFor(() => assert.deepEqual(editor.result.current.profiles, ['original', 'uploaded']))
  } finally {
    manager.unmount()
    editor.unmount()
    client.clear()
    globalThis.fetch = previousFetch
  }
})

test('a WebSocket invalidation replacing the save refresh cannot freeze the old catalogue again', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({})
  const requests: Array<(value: string[]) => void> = []
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
  const view = renderHook(() => {
    const query = useQuery({
      queryKey: ['slicing-profiles', 'engine'], initialData: ['original'], staleTime: Infinity,
      queryFn: ({ signal }) => new Promise<string[]>((resolve, reject) => {
        requests.push(resolve)
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      })
    })
    const snapshot = useSlicingPresetsSnapshot(query.data, { hold: true, ready: query.data.length > 0, scope: 'engine', refetch: query.refetch })
    return { ...snapshot, fetching: query.isFetching, save: useSaveSlicingPreset(snapshot.refresh) }
  }, { wrapper })
  try {
    let saving: Promise<void>
    act(() => { saving = view.result.current.save({ kind: 'process', name: 'custom', overwrite: false, config: {} }) })
    await waitFor(() => assert.equal(requests.length, 1))
    // The same write's socket event may arrive after its HTTP response. This cancels the
    // fetch joined by save() and starts another one while cached data still looks successful.
    await act(async () => { void client.invalidateQueries({ queryKey: ['slicing-profiles'] }) })
    await waitFor(() => assert.equal(requests.length, 2))
    await act(async () => { requests[1]!(['original', 'saved']); await saving })
    await waitFor(() => assert.equal(view.result.current.fetching, false))
    assert.deepEqual(view.result.current.profiles, ['original', 'saved'])
  } finally {
    view.unmount()
    client.clear()
    globalThis.fetch = previousFetch
  }
})
