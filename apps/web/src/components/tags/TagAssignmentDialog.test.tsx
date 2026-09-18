import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/printers' })
const React = (await import('react')).default
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { PromptDialogProvider } = await import('../PromptDialogProvider')
const { TagAssignmentDialog } = await import('./TagAssignmentDialog')
const originalFetch = globalThis.fetch

afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
after(() => dom.window.close())

test('mixed bulk edits send only changed tags as an object payload', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } })
  client.setQueryData(['auth-bootstrap', 'workspace:test'], {
    workspace: { id: 'w1', slug: 'test', name: 'Test' }, authEnabled: true, permissions: ['printers.view', 'printers.manage']
  })
  const snapshot = {
    tags: [
      { id: 'a', name: 'Workshop', group: 'Location', color: '#123456' },
      { id: 'b', name: 'Keep', group: '', color: '#654321' }
    ],
    assignments: { p1: ['a', 'b'], p2: ['b'] }
  }
  client.setQueryData(['tags', 'workspace:test', 'printer'], snapshot)
  let payload: unknown
  let closed = false
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      payload = JSON.parse(String(options.body))
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify(snapshot), { headers: { 'Content-Type': 'application/json' } })
  }
  const view = render(<QueryClientProvider client={client}><CssVarsProvider><PromptDialogProvider>
    <TagAssignmentDialog kind="printer" ids={['p1', 'p2']} onClose={() => { closed = true }} />
  </PromptDialogProvider></CssVarsProvider></QueryClientProvider>)
  assert.equal(view.getByRole('checkbox', { name: 'Workshop' }).getAttribute('aria-checked'), 'mixed')
  fireEvent.click(view.getByRole('checkbox', { name: 'Workshop' }))
  fireEvent.click(view.getByRole('button', { name: 'Apply' }))
  await waitFor(() => assert.equal(closed, true))
  assert.deepEqual(payload, { entityIds: ['p1', 'p2'], add: ['a'], remove: [] })
  cleanup()
  client.clear()
})


test('the grouped tag picker supports multiple selections without nested form controls', async () => {
  const { TagPicker } = await import('./TagPicker')
  const tags = [
    { id: 'a', name: 'Workshop', group: 'Location', color: '#123456' },
    { id: 'b', name: 'Demo', group: 'Purpose', color: '#654321' }
  ]
  let selection: string[] = []
  function Picker() {
    const [value, setValue] = React.useState<string[]>([])
    return <TagPicker tags={tags} value={value} onChange={(next) => { selection = next; setValue(next) }} />
  }
  const view = render(<CssVarsProvider><Picker /></CssVarsProvider>)
  fireEvent.click(view.getByRole('button', { name: 'Open' }))
  fireEvent.click(await view.findByRole('option', { name: 'Workshop' }))
  fireEvent.click(await view.findByRole('option', { name: 'Demo' }))
  assert.deepEqual(selection, ['a', 'b'])
  assert.equal(view.queryAllByRole('checkbox').length, 0)
})

test('tag color presets, suggestions, and custom hex update the selected color', async () => {
  const { TagColorPicker } = await import('./TagColorPicker')
  let selected = '#123456'
  const existingColors = ['#123456']
  function Picker() {
    const [color, setColor] = React.useState(selected)
    return <TagColorPicker color={color} existingColors={existingColors} onChange={(next) => { selected = next; setColor(next) }} />
  }
  const view = render(<CssVarsProvider><Picker /></CssVarsProvider>)
  assert.ok(view.getByText('Suggested colors'))
  assert.ok(view.getByText('Preset colors'))
  const firstSuggestion = view.getAllByRole('button').find((button) => button.hasAttribute('aria-pressed'))!
  fireEvent.click(firstSuggestion)
  assert.notEqual(selected, '#123456')
  assert.equal(firstSuggestion.getAttribute('aria-pressed'), 'true')
  fireEvent.change(view.getByRole('textbox', { name: 'Tag color hex' }), { target: { value: '#abcdef' } })
  assert.equal(selected, '#abcdef')
  assert.ok(view.getByRole('button', { name: 'Custom color' }))
})

test('assigned tag chips sort naturally by group then name', async () => {
  const { EntityTagChips } = await import('./EntityTagChips')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } })
  client.setQueryData(['auth-bootstrap', 'workspace:test'], {
    workspace: { id: 'w1', slug: 'test', name: 'Test' }, authEnabled: true, permissions: ['printers.view']
  })
  client.setQueryData(['tags', 'workspace:test', 'printer'], {
    tags: [
      { id: 'a', name: 'Tag 1', group: 'Group 10', color: '#123456' },
      { id: 'b', name: 'Tag 10', group: 'Group 2', color: '#123456' },
      { id: 'c', name: 'Tag 2', group: 'Group 2', color: '#123456' }
    ], assignments: { p1: ['a', 'b', 'c'] }
  })
  const view = render(<QueryClientProvider client={client}><CssVarsProvider><EntityTagChips kind="printer" id="p1" /></CssVarsProvider></QueryClientProvider>)
  assert.deepEqual([...view.container.querySelectorAll('.MuiChip-label')].map((chip) => chip.textContent), ['Tag 2', 'Tag 10', 'Tag 1'])
  cleanup()
  client.clear()
})
