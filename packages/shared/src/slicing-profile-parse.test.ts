import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureCliSupportedPresetFrom, isCliSupportedPresetFrom, parseProfileJson } from './slicing-profile-parse.js'

test('parseProfileJson stamps `from` on a preset saved without one', () => {
  // Exactly what the process/filament settings dialogs POST: `{ ...config, name, type }`. Stored
  // as-is, it makes every slice that loads it die at exit 251.
  const { raw } = parseProfileJson(JSON.stringify({
    name: '0.20mm @BBL P1P - OMADA STAND (custom)',
    type: 'process',
    layer_height: '0.2'
  }))

  assert.equal(raw.from, 'User')
})

test('parseProfileJson keeps a `from` BambuStudio exported', () => {
  const { raw } = parseProfileJson(JSON.stringify({
    name: 'Elegoo PETG PRO',
    type: 'filament',
    from: 'User'
  }))

  assert.equal(raw.from, 'User')
})

test('parseProfileJson replaces a `from` the CLI cannot load', () => {
  for (const from of ['', 'Project', 'Default', 'SYSTEM']) {
    const { raw } = parseProfileJson(JSON.stringify({ name: 'Custom', type: 'process', from }))
    assert.equal(raw.from, 'User', `expected ${JSON.stringify(from)} to be replaced`)
  }
})

test('isCliSupportedPresetFrom matches BambuStudio\'s asymmetric casing', () => {
  // load_config_file accepts `system` lowercase only, but BOTH `User` and `user`.
  assert.equal(isCliSupportedPresetFrom('system'), true)
  assert.equal(isCliSupportedPresetFrom('User'), true)
  assert.equal(isCliSupportedPresetFrom('user'), true)
  assert.equal(isCliSupportedPresetFrom('System'), false)
  assert.equal(isCliSupportedPresetFrom(''), false)
  assert.equal(isCliSupportedPresetFrom(undefined), false)
})

test('ensureCliSupportedPresetFrom falls back per provenance', () => {
  const builtin: Record<string, unknown> = { name: 'Bambu Lab P1S 0.4 nozzle' }
  ensureCliSupportedPresetFrom(builtin, 'system')
  assert.equal(builtin.from, 'system')

  const custom: Record<string, unknown> = { name: 'Custom', from: '' }
  ensureCliSupportedPresetFrom(custom, 'User')
  assert.equal(custom.from, 'User')
})
