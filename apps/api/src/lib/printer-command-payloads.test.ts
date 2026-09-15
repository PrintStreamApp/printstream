import assert from 'node:assert/strict'
import test from 'node:test'
import { commandToMqttPayloads } from './printer-command-payloads.js'

test('persistent print settings use the vendor command shapes', () => {
  assert.deepEqual(
    commandToMqttPayloads('H2D', { type: 'setPrintOption', option: 'foreignObjectDetection', enabled: true }, undefined),
    [{ xcam: { command: 'xcam_control_set', module_name: 'fod_check', control: true, enable: true, print_halt: true } }]
  )
  assert.deepEqual(
    commandToMqttPayloads('H2D', { type: 'setPurifyAirAtPrintEnd', mode: 'exhaust' }, undefined),
    [{ print: { command: 'print_option', air_purification: 2 } }]
  )
  assert.deepEqual(
    commandToMqttPayloads('H2D', { type: 'setOpenDoorDetection', mode: 'pause' }, undefined),
    [{ system: { command: 'set_door_stat', config: 2 } }]
  )
  assert.deepEqual(
    commandToMqttPayloads('H2D', { type: 'setSmartNozzleBlobDetection', mode: 'auto' }, undefined),
    [{ print: { command: 'print_option', nozzle_blob_detect_v2: 2 } }]
  )
})

test('nozzle rack controls use the holder motion and refresh commands', () => {
  assert.deepEqual(
    commandToMqttPayloads('H2C', { type: 'controlNozzleRack', action: 'home' }, undefined),
    [{ print: { command: 'nozzle_holder_ctrl', action: 0 } }]
  )
  assert.deepEqual(
    commandToMqttPayloads('H2C', { type: 'controlNozzleRack', action: 'raiseB' }, undefined),
    [{ print: { command: 'nozzle_holder_ctrl', action: 2 } }]
  )
  assert.deepEqual(
    commandToMqttPayloads('H2C', { type: 'controlNozzleRack', action: 'refreshAll' }, undefined),
    [{ print: { command: 'holder_nozzle_refresh', id: 0xff } }]
  )
})

test('external spool settings include the virtual spool slot address', () => {
  assert.deepEqual(
    commandToMqttPayloads('H2D', {
      type: 'setExternalSpool',
      amsId: 254,
      trayInfoIdx: 'GFL99',
      trayColor: '123456FF',
      trayType: 'PLA',
      nozzleTempMin: 190,
      nozzleTempMax: 230
    }, undefined),
    [{
      print: {
        command: 'ams_filament_setting',
        ams_id: 254,
        slot_id: 0,
        tray_id: 254,
        tray_info_idx: 'GFL99',
        tray_color: '123456FF',
        tray_type: 'PLA',
        nozzle_temp_min: 190,
        nozzle_temp_max: 230,
        setting_id: ''
      }
    }]
  )

  assert.deepEqual(
    commandToMqttPayloads('H2D', { type: 'resetExternalSpool', amsId: 255 }, undefined),
    [{
      print: {
        command: 'ams_filament_setting',
        ams_id: 255,
        slot_id: 0,
        tray_id: 254,
        tray_info_idx: '',
        tray_type: '',
        tray_sub_brands: '',
        tray_color: '00000000',
        nozzle_temp_min: 0,
        nozzle_temp_max: 0,
        setting_id: ''
      }
    }]
  )
})
