import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CORE_LANDING_PAGE_OPTIONS, withPrinterViewLandingPageOptions, type LandingPageOption } from './landingPageOptions'

const views = [
  { id: 'view-a', name: 'Shop floor' },
  { id: 'view-b', name: 'Farm rack' }
]

test('saved views are inserted directly after the Printers entry', () => {
  const options = withPrinterViewLandingPageOptions(CORE_LANDING_PAGE_OPTIONS, views)
  assert.deepEqual(options.map((option) => option.value), [
    '/printers',
    '/printers/views/view-a',
    '/printers/views/view-b',
    '/library',
    '/jobs',
    '/stats',
    '/settings'
  ])
  assert.equal(options[1]?.label, 'Printers: Shop floor')
  assert.equal(options[2]?.label, 'Printers: Farm rack')
})

test('no views leaves the options untouched', () => {
  assert.equal(withPrinterViewLandingPageOptions(CORE_LANDING_PAGE_OPTIONS, []), CORE_LANDING_PAGE_OPTIONS)
})

test('without a Printers entry the views append at the end', () => {
  const options: LandingPageOption[] = [{ value: '/library', label: 'Library' }]
  assert.deepEqual(
    withPrinterViewLandingPageOptions(options, views).map((option) => option.value),
    ['/library', '/printers/views/view-a', '/printers/views/view-b']
  )
})
