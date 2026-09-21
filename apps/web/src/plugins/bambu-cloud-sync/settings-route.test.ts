import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchRoutes } from 'react-router-dom'
import { bambuCloudSyncWebPlugin } from './index'
import { BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH } from './settings-route'

test('the enabled plugin contributes one canonical Bambu account settings destination', () => {
  assert.equal(BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH, '/settings/bambu-account')
  assert.equal(
    bambuCloudSyncWebPlugin.routes?.some((route) => route.path === `${BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH}/*`),
    true
  )
  assert.equal(
    bambuCloudSyncWebPlugin.slots?.some((slot) => slot.name === 'settings.overview'),
    true
  )
})

test('the plugin destination outranks the core Settings wildcard', () => {
  const matches = matchRoutes([
    { id: 'settings', path: '/workspaces/:workspaceSlug/settings/*' },
    { id: 'bambu-account', path: `/workspaces/:workspaceSlug${BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH}/*` }
  ], '/workspaces/home/settings/bambu-account')

  assert.equal(matches?.at(-1)?.route.id, 'bambu-account')
})
