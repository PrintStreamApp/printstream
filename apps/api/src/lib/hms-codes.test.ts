import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  getHmsDeviceType,
  getHmsDictionaryUrl,
  ingestHmsDictionaryForTests,
  isFreshHmsCacheFileForTests,
  lookupHmsMessage,
  resetHmsCodeServiceForTests
} from './hms-codes.js'

afterEach(() => {
  resetHmsCodeServiceForTests()
})

test('getHmsDeviceType normalizes the printer serial prefix', () => {
  assert.equal(getHmsDeviceType('0948ad590900302'), '094')
  assert.equal(getHmsDeviceType(' 239ABC '), '239')
  assert.equal(getHmsDeviceType('A1'), null)
  assert.equal(getHmsDeviceType(null), null)
})

test('getHmsDictionaryUrl appends the device type query parameter when present', () => {
  assert.equal(getHmsDictionaryUrl(), 'https://e.bambulab.com/query.php?lang=en')
  assert.equal(getHmsDictionaryUrl('0948AD590900302'), 'https://e.bambulab.com/query.php?lang=en&d=094')
})

test('lookupHmsMessage prefers device-specific dictionaries before the generic dictionary', () => {
  ingestHmsDictionaryForTests({
    data: {
      device_hms: {
        en: [{
          ecode: '0C0003000002001C',
          intro: 'Generic message'
        }]
      }
    }
  })
  ingestHmsDictionaryForTests({
    data: {
      device_hms: {
        en: [{
          ecode: '0C0003000002001C',
          intro: 'Device-specific message'
        }]
      }
    }
  }, '094')

  assert.equal(lookupHmsMessage('0C0003000002001C', '094'), 'Device-specific message')
  assert.equal(lookupHmsMessage('0C0003000002001C', '239'), 'Generic message')
})

test('isFreshHmsCacheFileForTests treats cache files as fresh for one refresh interval', () => {
  const now = Date.parse('2026-05-28T12:00:00.000Z')

  assert.equal(isFreshHmsCacheFileForTests(now - 23 * 60 * 60 * 1000, now), true)
  assert.equal(isFreshHmsCacheFileForTests(now - 24 * 60 * 60 * 1000, now), false)
})