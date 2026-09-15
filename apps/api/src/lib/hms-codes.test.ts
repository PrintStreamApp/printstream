import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  getHmsDeviceType,
  getHmsActionDictionaryUrl,
  getHmsDictionaryUrl,
  ingestHmsDictionaryForTests,
  ingestHmsActionDictionaryForTests,
  isFreshHmsCacheFileForTests,
  lookupHmsMessage,
  lookupHmsActions,
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

test('the vendor action table maps supported button ids and preserves an authoritative empty entry', () => {
  ingestHmsActionDictionaryForTests({
    data: [
      { ecode: '05004070', actions: [2, 6, 13, 999], device: '094' },
      { ecode: '0500807E', actions: [11], device: '094' }
    ]
  }, '094')

  assert.equal(getHmsActionDictionaryUrl('094'), 'https://e.bambulab.com/hms/GetActionImage.php?d=094')
  assert.deepEqual(lookupHmsActions('05004070', '094'), ['resume', 'checkAssistant', 'jumpToLiveView'])
  assert.deepEqual(lookupHmsActions('0500807E', '094'), [])
  assert.equal(lookupHmsActions('FFFFFFFF', '094'), null)
})

test('the vendor action table preserves the first matching device or default row', () => {
  ingestHmsActionDictionaryForTests({
    data: [
      { ecode: '05004070', actions: [13] },
      { ecode: '05004070', actions: [2], device: 'default' },
      { ecode: '05004070', actions: [13], device: '094' }
    ]
  }, '094')

  assert.deepEqual(lookupHmsActions('05004070', '094'), ['resume'])
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
