import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bambuCloudSettingDetailSchema,
  bambuCloudSettingListSchema,
  isBambuCloudChallengeResponse,
  isBambuCloudExpiryResponse,
  isBambuCloudQuotaResponse,
  parseBambuCloudUpdateTime,
  presetKindFromBambuCloudType,
  bambuCloudTypeFromPresetKind,
  shouldPullFromCloud
} from './bambu-cloud.js'

test('a Bambu timestamp is read as UTC regardless of the host zone', () => {
  // No zone marker in the wire format. A host running in America/Toronto that parsed
  // this as local time would place it 4-5 hours off and mis-order every conflict.
  const previousTz = process.env.TZ
  process.env.TZ = 'America/Toronto'
  try {
    assert.equal(parseBambuCloudUpdateTime('2026-04-06 19:03:50'), Date.UTC(2026, 3, 6, 19, 3, 50) / 1000)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test('both Bambu timestamp spellings parse to the same instant', () => {
  const fromDisplay = parseBambuCloudUpdateTime('2026-04-06 19:03:50')
  assert.equal(parseBambuCloudUpdateTime(String(fromDisplay)), fromDisplay)
})

test('an unreadable Bambu timestamp is null, never zero', () => {
  // Zero is a real comparable timestamp and would make an unparseable remote read as
  // infinitely OLD: the opposite of the safe answer.
  for (const value of ['', '   ', 'yesterday', '2026-13-45 99:99:99', null, undefined]) {
    assert.equal(parseBambuCloudUpdateTime(value), null, `expected null for ${JSON.stringify(value)}`)
  }
})

test('a preset is pulled only when the cloud copy is genuinely newer', () => {
  const base = { lastSyncedSettingId: 'PFUS1', lastSyncedCloudUpdateTime: 1_000, remoteSettingId: 'PFUS1' }

  assert.equal(shouldPullFromCloud({ ...base, remoteCloudUpdateTime: 2_000 }), true, 'cloud newer')
  assert.equal(shouldPullFromCloud({ ...base, remoteCloudUpdateTime: 1_000 }), false, 'same instant')
  assert.equal(shouldPullFromCloud({ ...base, remoteCloudUpdateTime: 500 }), false, 'local copy is the newer one')
})

test('a preset never synced, or whose cloud id changed, is always pulled', () => {
  assert.equal(shouldPullFromCloud({
    lastSyncedSettingId: null,
    lastSyncedCloudUpdateTime: null,
    remoteSettingId: 'PFUS1',
    remoteCloudUpdateTime: 10
  }), true)

  // Same name, different cloud preset: Studio's need_sync treats an id change as a
  // different preset even when the remote is older.
  assert.equal(shouldPullFromCloud({
    lastSyncedSettingId: 'PFUS1',
    lastSyncedCloudUpdateTime: 9_000,
    remoteSettingId: 'PFUS2',
    remoteCloudUpdateTime: 10
  }), true)
})

test('an unreadable remote timestamp pulls rather than assuming the local copy is current', () => {
  assert.equal(shouldPullFromCloud({
    lastSyncedSettingId: 'PFUS1',
    lastSyncedCloudUpdateTime: 1_000,
    remoteSettingId: 'PFUS1',
    remoteCloudUpdateTime: null
  }), true)
})

test('only a signed 401 counts as an expired credential', () => {
  assert.equal(isBambuCloudExpiryResponse({ status: 401, body: { code: 4, error: 'Please login.' } }), true)
  assert.equal(isBambuCloudExpiryResponse({ status: 401, body: { message: 'please login' } }), true)
  // A bare 401 is transient edge noise; signing the workspace out on it is the
  // regression bambuddy shipped and had to undo.
  assert.equal(isBambuCloudExpiryResponse({ status: 401, body: { error: 'forbidden region' } }), false)
  assert.equal(isBambuCloudExpiryResponse({ status: 401, body: null }), false)
  assert.equal(isBambuCloudExpiryResponse({ status: 403, body: { code: 4 } }), false)
})

test('a Cloudflare challenge is told apart from a real API answer', () => {
  assert.equal(isBambuCloudChallengeResponse({ status: 403, body: null, bodyText: '<html>Just a moment...</html>' }), true)
  assert.equal(isBambuCloudChallengeResponse({ status: 503, body: null, bodyText: '<html></html>' }), true)
  // A JSON body means we reached the API, whatever it said.
  assert.equal(isBambuCloudChallengeResponse({ status: 403, body: { error: 'nope' } }), false)
})

test('the preset quota rejection is recognised in either spelling', () => {
  assert.equal(isBambuCloudQuotaResponse({ status: 400, body: { code: 14 } }), true)
  assert.equal(isBambuCloudQuotaResponse({ status: 400, body: { code: '14' } }), true)
  assert.equal(isBambuCloudQuotaResponse({ status: 200, body: { code: 14 } }), false)
  assert.equal(isBambuCloudQuotaResponse({ status: 400, body: { code: 4 } }), false)
})

test('preset kinds round-trip through Bambu\'s own naming', () => {
  // Bambu says "print" for a process preset and "printer" for a machine preset.
  assert.equal(bambuCloudTypeFromPresetKind('process'), 'print')
  assert.equal(bambuCloudTypeFromPresetKind('machine'), 'printer')
  for (const kind of ['machine', 'process', 'filament'] as const) {
    assert.equal(presetKindFromBambuCloudType(bambuCloudTypeFromPresetKind(kind)), kind)
  }
})

/**
 * The exact top-level shape a live Bambu account returns for a detail read. Captured
 * from a real response, values trimmed. `setting_id` is genuinely absent: the caller
 * asked for it BY id, so Bambu does not echo it.
 */
const LIVE_DETAIL_RESPONSE = {
  message: 'success',
  code: null,
  error: null,
  public: false,
  version: '1.4.1.4',
  type: 'print',
  name: '0.20mm Standard - Higher Quality',
  update_time: '2023-05-31 12:20:38',
  nickname: null,
  base_id: 'GP015',
  setting: {
    inherits: '0.20mm Standard @BBL P1P',
    print_settings_id: '0.20mm Standard - Higher Quality',
    sparse_infill_pattern: 'gyroid',
    top_shell_layers: '4'
  },
  filament_id: null
}

test('a detail read parses even though Bambu omits setting_id from it', () => {
  // THE regression: this schema was derived from the LISTING summary, which requires
  // `setting_id`. A detail response has no such field, so every pull threw at the parse
  // before the preset was read: 49 presets reported as "could not sync" with a Zod dump
  // for a message, and a sync that claimed everything was already up to date.
  const parsed = bambuCloudSettingDetailSchema.parse(LIVE_DETAIL_RESPONSE)

  assert.equal(parsed.setting_id, undefined)
  assert.equal(parsed.name, '0.20mm Standard - Higher Quality')
  assert.equal(parsed.base_id, 'GP015')
  assert.equal(parsed.update_time, '2023-05-31 12:20:38')
  assert.equal(parsed.setting?.sparse_infill_pattern, 'gyroid')
})

test('a create response still surfaces the new setting_id', () => {
  // The other side of keeping it OPTIONAL rather than dropping it: create/update DO
  // return the id, and that is the only way a newly created preset gets bound.
  const parsed = bambuCloudSettingDetailSchema.parse({
    message: 'success',
    code: null,
    error: null,
    setting_id: 'PFUSdce8291f0b44ab',
    update_time: '2026-04-21 17:56:43'
  })

  assert.equal(parsed.setting_id, 'PFUSdce8291f0b44ab')
})

test('the listing keeps setting_id required, because a row without one cannot be bound', () => {
  const listed = bambuCloudSettingListSchema.parse({
    print: { private: [{ setting_id: 'PP1', name: 'A', update_time: '2023-05-31 12:20:38' }], public: [] },
    printer: { private: [], public: [] },
    filament: { private: [], public: [] }
  })
  assert.equal(listed.print?.private?.[0]?.setting_id, 'PP1')

  assert.throws(() => bambuCloudSettingListSchema.parse({
    print: { private: [{ name: 'no id here' }], public: [] }
  }))
})
