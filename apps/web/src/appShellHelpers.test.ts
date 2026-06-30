import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catchAllRouteDecision } from './appShellHelpers'

test('catchAllRouteDecision redirects genuinely unknown paths home', () => {
  // Not a plugin route: redirect home regardless of catalog state.
  assert.equal(catchAllRouteDecision({ isKnownPluginRoute: false, pluginCatalogResolving: true, hasPluginState: false }), 'redirect-home')
  assert.equal(catchAllRouteDecision({ isKnownPluginRoute: false, pluginCatalogResolving: false, hasPluginState: true }), 'redirect-home')
})

test('catchAllRouteDecision waits for a known plugin route while the catalog is still resolving', () => {
  // The hard-refresh bug: /queue is a real plugin route but its catalog hasn't landed yet on a cold load.
  // Must NOT redirect home — wait for the route to mount.
  assert.equal(catchAllRouteDecision({ isKnownPluginRoute: true, pluginCatalogResolving: true, hasPluginState: false }), 'wait')
})

test('catchAllRouteDecision defers a known plugin route to plugin handling once the catalog has resolved', () => {
  // Catalog resolved + still on the catch-all => the plugin is disabled (an enabled plugin's own route would
  // have matched). The disabled-route redirect handles it; the catch-all must not also send the user home.
  assert.equal(catchAllRouteDecision({ isKnownPluginRoute: true, pluginCatalogResolving: false, hasPluginState: true }), 'defer-to-plugin-handling')
})

test('catchAllRouteDecision redirects a known plugin route home when the catalog will never load', () => {
  // e.g. signed out: the catalog query is disabled, so no plugin route will ever mount — fall through to home.
  assert.equal(catchAllRouteDecision({ isKnownPluginRoute: true, pluginCatalogResolving: false, hasPluginState: false }), 'redirect-home')
})
