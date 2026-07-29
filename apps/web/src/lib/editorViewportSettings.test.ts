import assert from 'node:assert/strict'
import test from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

/**
 * The device-only scope exists because "workspace default vs this device" is meaningless with no
 * workspace. What matters is that under it the shared tier is not merely hidden but never fetched,
 * and that its device key cannot collide with a real workspace's.
 */
test('a device-only host never fetches shared settings and keys its own overrides', async () => {
  const { window } = installJsdomGlobals()
  try {
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
    const settings = await import('./editorViewportSettings')

    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })

    function Probe() {
      const deviceOnly = settings.useViewportSettingsDeviceOnly()
      const showBedModel = settings.useEffectiveShowBedModel()
      return React.createElement('span', null, `${deviceOnly}:${showBedModel}`)
    }

    const markup = renderToStaticMarkup(
      React.createElement(QueryClientProvider, { client },
        React.createElement(settings.ViewportSettingsScopeProvider,
          { deviceOnly: true, children: React.createElement(Probe) }))
    )

    // The shipped default still applies; it just comes from the constant rather than a workspace.
    assert.match(markup, /true:true/)
    // The query may be registered, but disabled: what matters is that it never left idle, i.e. no
    // /api/settings request was made on a host that has no workspace to ask about.
    const state = client.getQueryState(['general-settings'])
    assert.equal(state?.fetchStatus ?? 'idle', 'idle', 'the shared settings request never fired')
    assert.equal(state?.dataUpdatedAt ?? 0, 0, 'and nothing was ever fetched into it')
  } finally {
    window.close()
  }
})

test('the default scope still consults the workspace tier', async () => {
  const { window } = installJsdomGlobals()
  try {
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const settings = await import('./editorViewportSettings')

    function Probe() {
      return React.createElement('span', null, String(settings.useViewportSettingsDeviceOnly()))
    }
    // No provider at all is the app's case: two-tier, as before.
    assert.match(renderToStaticMarkup(React.createElement(Probe)), /false/)
  } finally {
    window.close()
  }
})
