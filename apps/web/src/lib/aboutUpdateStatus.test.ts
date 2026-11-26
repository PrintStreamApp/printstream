import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppVersionResponse } from '@printstream/shared'
import { describeAboutUpdateStatus } from './aboutUpdateStatus'

const current = { version: '1.3.22', serverVersion: '1.3.22', revision: 'abc', reloadRequired: false }

function server(update: AppVersionResponse['update'], canApplyUpdate = false): AppVersionResponse {
  return { version: '1.3.22', revision: 'abc', shortRevision: 'abc', published: update !== null, update, canApplyUpdate } as AppVersionResponse
}

function info(status: 'current' | 'updateAvailable' | 'updatesLapsed' | 'unknown') {
  return { status, latestRevision: 'def', latestShortRevision: 'def', checkedAt: null, imageRef: null, downloadUrl: null } as NonNullable<AppVersionResponse['update']>
}

test('reports checking, latest, and an unknown check in the kit wording', () => {
  assert.equal(describeAboutUpdateStatus(undefined, current, false).message, 'Checking for updates\u2026')
  assert.deepEqual(describeAboutUpdateStatus(server(null), current, false), { message: 'You have the latest version.', attention: false })
  assert.deepEqual(describeAboutUpdateStatus(server(info('current')), current, false), { message: 'You have the latest version.', attention: false })
  assert.equal(describeAboutUpdateStatus(server(info('unknown')), current, false).message, 'Couldn’t check for updates. Try again later.')
})

test('an available update points at the footer only when this viewer can apply it', () => {
  const viewer = describeAboutUpdateStatus(server(info('updateAvailable')), current, false)
  assert.equal(viewer.message, 'A newer version is available (build def).')
  assert.equal(viewer.attention, true)
  const manager = describeAboutUpdateStatus(server(info('updateAvailable'), true), current, false)
  assert.match(manager.message, /Install it from "Update available"/)
  assert.match(describeAboutUpdateStatus(server(info('updatesLapsed')), current, false).message, /updates period has ended/)
})

test('a newer web build waiting to load is reported before anything else', () => {
  const stale = { ...current, serverVersion: '1.3.23', revision: null, reloadRequired: true }
  assert.equal(
    describeAboutUpdateStatus(server(info('updateAvailable')), stale, false).message,
    'Version 1.3.23 is ready. PrintStream reloads into it automatically once nothing is open.'
  )
  assert.equal(describeAboutUpdateStatus(server(null), current, true).attention, true)
})
