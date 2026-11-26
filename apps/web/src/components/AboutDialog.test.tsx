import assert from 'node:assert/strict'
import test from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const VERSION_RESPONSE = { version: null, revision: 'abc1234', shortRevision: 'abc1234', published: false, update: null, canApplyUpdate: false }

async function renderAbout(props: { deployment: 'cloud' | 'self-hosted'; withSupport: boolean }) {
  const { render } = await import('@testing-library/react')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { AboutDialog } = await import('./AboutDialog')
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  const calls = { closed: 0, support: 0 }
  const view = render(
    <QueryClientProvider client={client}>
      <AboutDialog
        deployment={props.deployment}
        onClose={() => { calls.closed += 1 }}
        onOpenSupport={props.withSupport ? () => { calls.support += 1 } : undefined}
      />
    </QueryClientProvider>
  )
  return { view, calls, client }
}

test('About lists the standard links in order, and Support hands over to Help & feedback', async () => {
  const dom = installJsdomGlobals()
  const { cleanup, fireEvent, waitFor } = await import('@testing-library/react')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(VERSION_RESPONSE), { headers: { 'content-type': 'application/json' } })
  try {
    const { view, calls, client } = await renderAbout({ deployment: 'self-hosted', withSupport: true })
    await waitFor(() => assert.match(view.baseElement.textContent ?? '', /You have the latest version\./))

    const text = view.baseElement.textContent ?? ''
    assert.match(text, /PrintStream/)
    assert.match(text, /Version \d+\.\d+\.\d+/)
    const order = ['Updates', 'Links', 'Source code', 'Privacy policy', 'Support', 'License', 'Third-party notices']
    const positions = order.map((label) => text.indexOf(label))
    assert.ok(positions.every((position) => position >= 0), `every label present: ${positions}`)
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'labels appear in the BRAND-8 order')
    assert.ok(!text.includes('Terms of Service'), 'self-hosted builds do not link the hosted terms')
    assert.equal(view.getByRole('link', { name: 'Third-party notices' }).getAttribute('href'), '/THIRD-PARTY-NOTICES.txt')

    fireEvent.click(view.getByRole('button', { name: 'Support' }))
    assert.deepEqual(calls, { closed: 1, support: 1 })
    client.clear()
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('the hosted edition adds its Terms of Service, and Support is omitted where Help is not offered', async () => {
  const dom = installJsdomGlobals()
  const { cleanup } = await import('@testing-library/react')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(VERSION_RESPONSE), { headers: { 'content-type': 'application/json' } })
  try {
    const { view, client } = await renderAbout({ deployment: 'cloud', withSupport: false })
    assert.ok(view.getByRole('link', { name: 'Terms of Service' }))
    assert.equal(view.queryByRole('button', { name: 'Support' }), null)
    client.clear()
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})
