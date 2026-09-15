import assert from 'node:assert/strict'
import test from 'node:test'
import { printerSettingMatchesCommand } from './printer-setting-confirmation.js'
import { makeOfflineStatus } from './bambu-report-parser.js'

const status = makeOfflineStatus({
  id: 'printer-1',
  name: 'Printer',
  host: 'printer.local',
  serial: 'SERIAL',
  accessCode: 'CODE',
  model: 'H2D',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z'
})

test('printer setting confirmation compares each capability-backed setting value', () => {
  status.ductMode = 'heating'
  status.printOptions.filamentTangleDetection.enabled = true
  status.printOptions.purifyAirAtPrintEnd.current = 'internal'
  status.printOptions.openDoorDetection.current = 'notify'
  status.printOptions.smartNozzleBlobDetection.current = 'auto'
  status.printOptions.cameraResolution.current = '1080p'

  assert.equal(printerSettingMatchesCommand(status, { type: 'setAirductMode', mode: 'heating' }), true)
  assert.equal(printerSettingMatchesCommand(status, { type: 'setPrintOption', option: 'filamentTangleDetection', enabled: true }), true)
  assert.equal(printerSettingMatchesCommand(status, { type: 'setPurifyAirAtPrintEnd', mode: 'internal' }), true)
  assert.equal(printerSettingMatchesCommand(status, { type: 'setOpenDoorDetection', mode: 'notify' }), true)
  assert.equal(printerSettingMatchesCommand(status, { type: 'setSmartNozzleBlobDetection', mode: 'auto' }), true)
  assert.equal(printerSettingMatchesCommand(status, { type: 'setCameraResolution', resolution: '1080p' }), true)
  assert.equal(printerSettingMatchesCommand(status, { type: 'pause' }), null)
  assert.equal(printerSettingMatchesCommand(undefined, { type: 'refresh' }), null)
  assert.equal(printerSettingMatchesCommand(status, { type: 'setPrintOption', option: 'filamentTangleDetection', enabled: false }), false)
})
