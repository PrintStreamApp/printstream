import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrinterStatus } from './printer-contracts.js'
import type { SlotMaterialIdentity } from './slot-material.js'
import { blacklistProhibitions } from './filament-blacklist.js'
import { checkFilamentBlacklistForAssignment, checkPrinterFilamentBlacklist } from './filament-blacklist-slots.js'

const identity: SlotMaterialIdentity = { brand: 'Bambu', filamentType: 'PET-CF', materialSubtype: 'PET-CF', colorName: 'Black' }

/** Only the live hardware and tray fields read by the adapter are needed for these fixtures. */
function status(materialIdentity: SlotMaterialIdentity | null, hardwareType = 'PET-CF', external = false): PrinterStatus {
  const tray = { slot: 0, amsId: 255, nozzleId: 0, occupied: true, trayInfoIdx: null, trayUuid: null,
    trayName: `Generic ${hardwareType}`, filamentType: hardwareType, color: '#000000', colors: ['#000000'], materialIdentity }
  return { ams: external ? [] : [{ unitId: 0, type: 'ams', nozzleId: 0, switchInput: null, slots: [tray] }],
    externalSpools: external ? [tray] : [], nozzles: [{ extruderId: 0, diameter: '0.4', flow: 'standard' }],
    filamentTrackSwitch: null } as unknown as PrinterStatus
}
function findings(value: PrinterStatus, trayIndex = 0, printerModel = 'P1S') {
  return checkPrinterFilamentBlacklist({ printerModel, status: value, amsMapping: [trayIndex] }).flatMap((entry) => entry.findings)
}

test('manual Bambu PET-CF retains its AMS prohibition when firmware reports a generic preset', () => {
  assert.ok(blacklistProhibitions(findings(status(identity))).some((finding) => finding.message.includes('PET-CF')))
  assert.equal(blacklistProhibitions(findings(status(null))).length, 0)
  assert.equal(blacklistProhibitions(findings(status({ ...identity, brand: 'Other brand' }))).length, 0)
})

test('draft and saved manual identities receive identical safety findings', () => {
  const current = status(null)
  const draft = checkFilamentBlacklistForAssignment({ printerModel: 'P1S', status: current, amsId: 0, slotId: 0,
    filamentType: 'PET-CF', filamentId: null, filamentName: 'Generic PET-CF', filamentVendor: 'Generic', materialIdentity: identity })
  assert.deepEqual(draft, findings(status(identity)))
})

test('physical TPU cannot hide behind PLA compatibility, while external mounting removes its AMS prohibition', () => {
  const tpu = { ...identity, brand: null, filamentType: 'TPU', materialSubtype: null }
  assert.ok(blacklistProhibitions(findings(status(tpu, 'PLA'))).some((finding) => finding.message.includes('TPU is not supported by AMS')))
  assert.equal(blacklistProhibitions(findings(status(tpu, 'PLA', true), 255)).length, 0)
})

test('external identity preserves product-specific nozzle warnings', () => {
  const tpu = { ...identity, brand: 'Bambu Lab', filamentType: 'TPU', materialSubtype: 'TPU 85A' }
  const result = findings(status(tpu, 'PLA', true), 255, 'H2D')
  assert.ok(result.some((finding) => finding.message.includes('Bambu TPU 85A')))
})

test('unrecognized physical names do not disable the compatibility type safety checks', () => {
  const custom = { ...identity, brand: null, filamentType: 'My flexible polymer', materialSubtype: null }
  assert.ok(blacklistProhibitions(findings(status(custom, 'TPU'))).some((finding) => finding.message.includes('TPU is not supported by AMS')))
})

test('a compatibility preset cannot grant a physical material a whitelist exemption', () => {
  const value = status({ ...identity, filamentType: 'PETG', materialSubtype: null }, 'TPU', true)
  value.externalSpools[0]!.trayInfoIdx = 'GFU99'
  value.nozzles[0]!.flow = 'tpu-high'
  const result = findings(value, 255, 'H2D')
  assert.ok(blacklistProhibitions(result).some((finding) => finding.message.includes('TPU high-flow nozzle')))
})

test('inventory handoff preserves manual safety findings and manual identity wins over inventory', () => {
  const before = checkPrinterFilamentBlacklist({ printerModel: 'P1S', status: status(identity), amsMapping: [0] })
  const after = checkPrinterFilamentBlacklist({ printerModel: 'P1S', status: status(null), amsMapping: [0], inventoryIdentities: new Map([[0, identity]]) })
  assert.deepEqual(after, before)
  const manual = checkPrinterFilamentBlacklist({ printerModel: 'P1S', status: status(identity), amsMapping: [0], inventoryIdentities: new Map([[0, { ...identity, brand: 'Other' }]]) })
  assert.deepEqual(manual, before)
})
