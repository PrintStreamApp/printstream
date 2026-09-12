/** The footer must identify the UI loaded in this tab, not a newer API deployment. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppVersionResponse } from '@printstream/shared'
import webPackage from '../../package.json'
import { resolveDisplayedAppBuild } from './appVersionDisplay'

function serverBuild(version: string | null, revision = 'abcdef123456'): AppVersionResponse {
  return {
    version,
    revision,
    shortRevision: revision.slice(0, 7),
    published: false,
    update: null,
    canApplyUpdate: false
  }
}

test('shows the version compiled into the loaded UI when the server is newer', () => {
  const displayed = resolveDisplayedAppBuild(serverBuild('999.0.0'))

  assert.deepEqual(displayed, {
    version: webPackage.version,
    revision: null,
    serverVersion: '999.0.0',
    reloadRequired: true
  })
})

test('keeps the server revision when it describes the loaded UI version', () => {
  const displayed = resolveDisplayedAppBuild(serverBuild(webPackage.version))

  assert.deepEqual(displayed, {
    version: webPackage.version,
    revision: 'abcdef123456',
    serverVersion: webPackage.version,
    reloadRequired: false
  })
})

test('still identifies the loaded UI while the version request is unavailable', () => {
  assert.deepEqual(resolveDisplayedAppBuild(undefined), {
    version: webPackage.version,
    revision: null,
    serverVersion: null,
    reloadRequired: false
  })
})
