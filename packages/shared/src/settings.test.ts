import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appLandingPageSettingSchema, generalSettingsSchema, updateGeneralSettingsSchema } from './settings.js'

test('landing page accepts app-relative page and printer-view addresses', () => {
  // Saved printer views land at `/printers/views/<cuid>` (see the web's
  // lib/printerViewRoutes.ts); these values are persisted in workspace settings
  // and device overrides, so the schema must keep accepting them.
  assert.equal(appLandingPageSettingSchema.parse('/printers'), '/printers')
  assert.equal(
    appLandingPageSettingSchema.parse('/printers/views/clxyzabc1234567890printer'),
    '/printers/views/clxyzabc1234567890printer'
  )
})

test('landing page keeps mapping legacy page names onto paths', () => {
  assert.equal(appLandingPageSettingSchema.parse('library'), '/library')
})

test('default printer view defaults to null (Overview) and accepts a view id', () => {
  assert.equal(generalSettingsSchema.parse({}).printersDefaultViewId, null)
  assert.equal(generalSettingsSchema.parse({ printersDefaultViewId: 'clviewid1234' }).printersDefaultViewId, 'clviewid1234')

  // Update payloads distinguish "leave untouched" (absent) from "clear" (null).
  const update = updateGeneralSettingsSchema.parse({ printersDefaultViewId: null })
  assert.equal(update.printersDefaultViewId, null)
  assert.equal(updateGeneralSettingsSchema.safeParse({ printersDefaultViewId: '' }).success, false)
  assert.equal(updateGeneralSettingsSchema.safeParse({}).success, false)
})

test('landing page rejects values that are not app-relative paths', () => {
  assert.equal(appLandingPageSettingSchema.safeParse('https://example.com').success, false)
  assert.equal(appLandingPageSettingSchema.safeParse('/Printers/Views/ABC').success, false)
  assert.equal(appLandingPageSettingSchema.safeParse('/printers/').success, false)
})
