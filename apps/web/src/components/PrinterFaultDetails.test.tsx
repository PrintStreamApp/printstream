import assert from 'node:assert/strict'
import { after, afterEach, mock, test } from 'node:test'
import type { PrinterFault } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react')
const { PrinterFaultDetails } = await import('./PrinterFaultDetails')
const clients: InstanceType<typeof QueryClient>[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); mock.restoreAll() })
after(() => dom.window.close())
const fault: PrinterFault = {
  id: 'fault', source: 'device_error', code: '07008011', message: 'Filament exhausted',
  firstObservedAt: '2026-10-25T16:00:00.000Z', lastObservedAt: '2026-10-25T16:01:00.000Z',
  observedClearedAt: null, state: 'active', alreadyPresent: true, gaps: []
}
function draw(faults: PrinterFault[], canDelete = false) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } } })
  clients.push(client)
  return render(<CssVarsProvider><QueryClientProvider client={client}><PrinterFaultDetails faults={faults} canDelete={canDelete} /></QueryClientProvider></CssVarsProvider>)
}

test('live count expands source, code, carryover and Toronto observation detail', () => {
  draw([fault])
  const toggle = screen.getByRole('button', { name: '1 fault' })
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.match(screen.getByText(/Device print error:/).textContent ?? '', /07008011/)
  assert.match(screen.getByText(/First observed/).textContent ?? '', /Already present.*12:00 p.m./)
  assert.ok(screen.getByText(/Ongoing at last observation/))
  assert.equal(screen.queryByRole('button', { name: 'Delete fault history' }), null)
})

test('uncertain state exposes retained gaps and offers no deletion even with permission', () => {
  draw([{ ...fault, state: 'uncertain', gaps: [{ startedAt: '2026-10-25T16:01:00.000Z', endedAt: null, reason: 'disconnect' }] }], true)
  fireEvent.click(screen.getByRole('button', { name: '1 fault' }))
  assert.ok(screen.getByText(/State uncertain/))
  assert.ok(screen.getByText(/awaiting a fresh report from this source/))
  assert.equal(screen.queryByRole('button', { name: 'Delete fault history' }), null)
})

test('cleared faults expose deletion only when permitted and update when live data changes', () => {
  const rendered = draw([fault], true)
  fireEvent.click(screen.getByRole('button', { name: '1 fault' }))
  assert.equal(screen.queryByRole('button', { name: 'Delete fault history' }), null)
  const client = clients[0]!
  rendered.rerender(<CssVarsProvider><QueryClientProvider client={client}><PrinterFaultDetails faults={[{ ...fault, state: 'cleared', observedClearedAt: '2026-10-25T16:03:00.000Z' }]} canDelete /></QueryClientProvider></CssVarsProvider>)
  assert.ok(screen.getByText(/Clear observed/))
  assert.ok(screen.getByRole('button', { name: 'Delete fault history' }))
})

/** Route history makes an unspent dialog entry observable on the user's next Back. */
function openDeletion() {
  window.history.replaceState({}, '', '/before-faults')
  window.history.pushState({}, '', '/jobs')
  const rendered = draw([{ ...fault, state: 'cleared', observedClearedAt: '2026-10-25T16:03:00.000Z' }], true)
  fireEvent.click(screen.getByRole('button', { name: '1 fault' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete fault history' }))
  assert.ok(screen.getByRole('alertdialog'))
  return rendered
}

test('Cancel consumes the confirmation history entry before the next browser Back', async () => {
  openDeletion()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => assert.deepEqual(window.history.state.__printStreamDialogStack ?? [], []))
  window.history.back()
  await waitFor(() => assert.equal(window.location.pathname, '/before-faults'))
})

test('successful deletion closes history before invalidation removes the last fault card', async () => {
  const rendered = openDeletion()
  const invalidated: unknown[] = []
  mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }))
  mock.method(clients[0]!, 'invalidateQueries', async (options: unknown) => {
    assert.equal(screen.queryByRole('alertdialog'), null, 'open=false commits before a cache refresh can unmount the card')
    invalidated.push(options)
    rendered.unmount()
  })
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete fault history' }))
  await waitFor(() => assert.equal(invalidated.length, 2))
  await waitFor(() => assert.deepEqual(window.history.state.__printStreamDialogStack ?? [], []))
  window.history.back()
  await waitFor(() => assert.equal(window.location.pathname, '/before-faults'))
})
