import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  derivePluginDefaultEnableMode,
  isPluginEnabledByDefault
} from './default-enable-mode.js'

test('fresh installs default plugins to disabled', () => {
  const mode = derivePluginDefaultEnableMode(0)

  assert.equal(mode, 'disabled')
  assert.equal(isPluginEnabledByDefault(mode), false)
})

test('existing installs keep plugins enabled when no explicit state exists', () => {
  const mode = derivePluginDefaultEnableMode(3)

  assert.equal(mode, 'enabled')
  assert.equal(isPluginEnabledByDefault(mode), true)
})