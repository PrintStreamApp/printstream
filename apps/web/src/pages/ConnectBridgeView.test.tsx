import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { WorkspaceSummary } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

// Joy components must load after the jsdom globals exist (SSR detection at import).
const React = (await import('react')).default
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, render, waitFor } = await import('@testing-library/react')
const { MemoryRouter } = await import('react-router-dom')
const { ConnectBridgeView } = await import('./ConnectBridgeView')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function workspace(id: string, name: string): WorkspaceSummary {
  return { id, slug: id, name }
}

test('ConnectBridgeView warns when the deep link has no code', () => {
  const view = render(
    <CssVarsProvider>
      <ConnectBridgeView code={null} workspaces={[workspace('a', 'A')]} activeWorkspaceId={null} pending={false} onConnect={() => {}} />
    </CssVarsProvider>
  )

  assert.match(view.getByRole('alert').textContent ?? '', /missing a bridge connect code/i)
})

test('ConnectBridgeView prompts for a workspace when several are accessible', () => {
  const selected: string[] = []
  const view = render(
    <MemoryRouter>
      <CssVarsProvider>
        <ConnectBridgeView
          code="ABCD1234"
          workspaces={[workspace('a', 'Workspace A'), workspace('b', 'Workspace B')]}
          activeWorkspaceId={null}
          pending={false}
          onConnect={(id) => selected.push(id)}
        />
      </CssVarsProvider>
    </MemoryRouter>
  )

  assert.ok(view.getByText('Connect your bridge'))
  view.getByRole('button', { name: /Workspace A/ }).click()
  assert.deepEqual(selected, ['a'])
})

test('ConnectBridgeView connects straight through to a single workspace', async () => {
  const selected: string[] = []
  render(
    <CssVarsProvider>
      <ConnectBridgeView
        code="ABCD1234"
        workspaces={[workspace('solo', 'Only Workspace')]}
        activeWorkspaceId={null}
        pending={false}
        onConnect={(id) => selected.push(id)}
      />
    </CssVarsProvider>
  )

  await waitFor(() => assert.deepEqual(selected, ['solo']))
})

test('ConnectBridgeView falls back to the active workspace when no list is available', async () => {
  const selected: string[] = []
  render(
    <CssVarsProvider>
      <ConnectBridgeView
        code="ABCD1234"
        workspaces={[]}
        activeWorkspaceId="active"
        pending={false}
        onConnect={(id) => selected.push(id)}
      />
    </CssVarsProvider>
  )

  await waitFor(() => assert.deepEqual(selected, ['active']))
})
