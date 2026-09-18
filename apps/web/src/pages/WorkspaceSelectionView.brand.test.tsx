import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const { cleanup, render } = await import('@testing-library/react')
const { MemoryRouter } = await import('react-router-dom')
const { runtimePolicyContext } = await import('../lib/runtimePolicy')
const { WorkspaceSelectionView } = await import('./WorkspaceSelectionView')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

function renderChooser(selfHosted: boolean) {
  return render(
    <runtimePolicyContext.Provider value={{ demoMode: false, managedBridge: false, selfHosted }}>
      <MemoryRouter>
        <WorkspaceSelectionView workspaceOptions={[]} onWorkspaceSelect={() => {}} />
      </MemoryRouter>
    </runtimePolicyContext.Provider>
  )
}

test('cloud chooser brand links to the marketing home', () => {
  const view = renderChooser(false)
  const link = view.getByRole('link', { name: 'PrintStream home' })
  assert.equal(link.getAttribute('href'), '/')
})

test('self-hosted chooser brand remains non-interactive', () => {
  const view = renderChooser(true)
  assert.equal(view.queryByRole('link', { name: 'PrintStream home' }), null)
})

test('cloud workspaces are listed before administrative workspaces', () => {
  const view = render(
    <runtimePolicyContext.Provider value={{ demoMode: false, managedBridge: false, selfHosted: false }}>
      <MemoryRouter>
        <WorkspaceSelectionView
          workspaceOptions={[{ id: 'farm', slug: 'farm', name: 'Farm' }]}
          allowPlatformSelection
          onPlatformSelect={() => {}}
          onWorkspaceSelect={() => {}}
        />
      </MemoryRouter>
    </runtimePolicyContext.Provider>
  )

  const text = view.container.textContent ?? ''
  assert.ok(text.indexOf('Cloud workspaces') < text.indexOf('Administrative workspaces'))
  assert.ok(text.indexOf('Farm') < text.indexOf('Platform'))
})
