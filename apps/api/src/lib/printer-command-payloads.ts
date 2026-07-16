/**
 * Translation of high-level printer commands into Bambu MQTT payloads.
 *
 * `commandToMqttPayloads` is the single place that maps a validated
 * `printerCommandSchema` command into the concrete `print`/`system`/`xcam`
 * MQTT messages a Bambu printer understands, branching on printer model and
 * the live status' reported command transport (new vs. legacy gcode paths).
 * The `POST /api/printers/:id/command` route validates and gates the command,
 * then publishes whatever payloads this returns.
 *
 * The new-vs-legacy branch is per-printer, not per-model: each control reads a
 * `status.commandTransport.*` capability flag (derived from what the live
 * status reports the firmware supports) and emits the structured native `print`
 * command when available, else falls back to a raw `gcode_line`. So the same
 * model can take either path depending on its firmware. Where the legacy
 * fallback moves an axis, motion direction depends on the motion system (see
 * `legacyMotionDistance`).
 *
 * `resolvePressureAdvanceCommandContext` is also consumed by the
 * pressure-advance-profiles route, so it is exported alongside the translator.
 */
import {
  AMS_HT_TRAY_INDEX_MIN,
  amsTrayIndex,
  getPrinterControlCapabilities,
  printerCommandSchema,
  printerModelSchema,
  supportsPrinterSecondaryChamberLight,
  usesCoreXyMotionSystem,
  type Printer
} from '@printstream/shared'
import { badRequest } from './http-error.js'
import { printerManager } from './printer-manager.js'
import { calibrationOption } from './printer-calibration.js'

const VIRTUAL_TRAY_SETTING_ID = 254
const VIRTUAL_TRAY_UNLOAD_TARGET = 255

function resolveAmsChangeFilamentTarget(amsId: number, slotId: number): number {
  if (amsId < 16) {
    const trayId = amsId * 4 + slotId
    return trayId === 0 ? amsId : trayId
  }
  return amsId
}

/**
 * Global `tray_id` for an AMS slot in a `print` command, resolving the unit's
 * AMS generation from live status so AMS HT (N3S, ids 128-152) units get their
 * id-as-tray-index numbering instead of `amsId * 4 + slotId`. Falls back to the
 * id band when the unit isn't in status yet. See `amsTrayIndex` for the rules.
 */
function resolveCommandTrayId(
  status: ReturnType<typeof printerManager.getStatus>,
  amsId: number,
  slotId: number
): number {
  const unitType = status?.ams.find((unit) => unit.unitId === amsId)?.type
    ?? (amsId >= AMS_HT_TRAY_INDEX_MIN ? 'ams-ht' : 'ams')
  return amsTrayIndex(unitType, amsId, slotId)
}

export function commandToMqttPayloads(
  model: string,
  command: ReturnType<typeof printerCommandSchema.parse>,
  status: ReturnType<typeof printerManager.getStatus>
): Record<string, unknown>[] {
  const normalizedModel = printerModelSchema.safeParse(model).success ? printerModelSchema.parse(model) : 'unknown'

  switch (command.type) {
    case 'pause':
      return [{ print: { command: 'pause' } }]
    case 'resume':
      if (status?.deviceError != null) {
        const parsedError = Number.parseInt(status.deviceError.code, 16)
        if (status.jobId && Number.isFinite(parsedError)) {
          return [{
            print: {
              command: 'resume',
              err: String(parsedError),
              param: 'reserve',
              job_id: status.jobId
            }
          }]
        }
        return [
          { print: { command: 'clean_print_error' } },
          { print: { command: 'resume' } }
        ]
      }
      return [{ print: { command: 'resume' } }]
    case 'ignoreHmsError': {
      const parsedError = status?.deviceError ? Number.parseInt(status.deviceError.code, 16) : Number.NaN
      if (status?.jobId && Number.isFinite(parsedError)) {
        return [{
          print: {
            command: 'ignore',
            err: String(parsedError),
            param: 'reserve',
            job_id: status.jobId
          }
        }]
      }
      throw badRequest('Printer warning could not be ignored because the printer did not report a resumable warning id')
    }
    case 'retryAmsFilamentChange':
      return [{ print: { command: 'ams_control', param: 'resume' } }]
    case 'confirmAmsFilamentExtruded':
      return [{ print: { command: 'ams_control', param: 'done' } }]
    case 'stop':
      return [{ print: { command: 'stop' } }]
    case 'light':
      return buildLightCommandPayloads(normalizedModel, command)
    case 'setAirductMode':
      return [{
        print: {
          command: 'set_airduct',
          modeId: command.mode === 'cooling' ? 0 : 1,
          submode: -1
        }
      }]
    case 'setPrintOption':
      return [printOptionToMqttPayload(command)]
    case 'refresh':
      return [
        { info: { command: 'get_version' } },
        { pushing: { command: 'pushall' } }
      ]
    case 'setNozzleTemperature':
      return getPrinterControlCapabilities(normalizedModel).dualNozzles
        ? [{
            print: {
              command: 'set_nozzle_temp',
              extruder_index: command.extruderId,
              target_temp: command.target
            }
          }]
        : [{
            print: {
              command: 'gcode_line',
              param: `M104 S${command.target}\n`
            }
          }]
    case 'setBedTemperature':
      return [bedTemperaturePayload(command.target, status)]
    case 'setChamberTemperature':
      return [{
        print: {
          command: 'set_ctt',
          ctt_val: command.target
        }
      }]
    case 'setFanSpeed':
      return [fanSpeedPayload(command.fan, command.percent, status)]
    case 'setPrintSpeed':
      return [{
        print: {
          command: 'print_speed',
          param: String(command.level)
        }
      }]
    case 'moveAxis':
      return [motionPayload(command.axis, command.distanceMm, normalizedModel, status)]
    case 'homeAxes':
      return [homingPayload(status)]
    case 'extrudeFilament':
      return [{
        print: {
          command: 'set_extrusion_length',
          extruder_index: command.extruderId,
          length: command.distanceMm
        }
      }]
    case 'setAmsUserSettings':
      return [{
        print: {
          command: 'ams_user_setting',
          ams_id: -1,
          startup_read_option: command.startupReadOption,
          tray_read_option: command.trayReadOption,
          calibrate_remain_flag: command.calibrateRemainFlag
        }
      }]
    case 'setAmsFilamentBackup':
      return [{
        print: {
          command: 'print_option',
          auto_switch_filament: command.enabled
        }
      }]
    case 'startAmsDrying':
      return [{
        print: {
          command: 'ams_filament_drying',
          ams_id: command.amsId,
          mode: 1,
          filament: command.filamentType,
          temp: command.temperature,
          duration: command.durationHours,
          humidity: 0,
          rotate_tray: command.rotateTray,
          cooling_temp: command.coolingTemp,
          close_power_conflict: command.closePowerConflict
        }
      }]
    case 'stopAmsDrying':
      return [{
        print: {
          command: 'ams_filament_drying',
          ams_id: command.amsId,
          mode: 0,
          filament: '',
          temp: 0,
          duration: 0,
          humidity: 0,
          rotate_tray: false,
          cooling_temp: 0,
          close_power_conflict: false
        }
      }]
    case 'rescanAmsSlot':
      return [{
        print: {
          command: 'ams_get_rfid',
          ams_id: command.amsId,
          slot_id: command.slotId
        }
      }]
    case 'calibrate': {
      const option = calibrationOption(command)
      if (option === 0) throw badRequest('At least one calibration option must be selected')
      return []
    }
    case 'clearHmsErrors':
      // Bambu firmware acknowledges HMS popups via `clean_print_error`.
      // The numeric `print_error` field, when present, scopes the clear
      // to a single code; without it the firmware clears whichever
      // error is currently displayed. We pass the dotted HMS code as
      // text since firmwares vary and unknown fields are ignored.
      return command.code
        ? [{ print: { command: 'clean_print_error', print_error: command.code } }]
        : [{ print: { command: 'clean_print_error' } }]
    case 'skipObjects':
      return [{ print: { command: 'skip_objects', obj_list: command.objectIds } }]
    case 'setAmsSlot':
      return [{
        print: {
          command: 'ams_filament_setting',
          ams_id: command.amsId,
          tray_id: command.slotId,
          tray_info_idx: command.trayInfoIdx,
          tray_color: command.trayColor.toUpperCase(),
          tray_type: command.trayType,
          nozzle_temp_min: command.nozzleTempMin,
          nozzle_temp_max: command.nozzleTempMax,
          setting_id: ''
        }
      }]
    case 'resetAmsSlot':
      return [{
        print: {
          command: 'ams_filament_setting',
          ams_id: command.amsId,
          tray_id: command.slotId,
          tray_info_idx: '',
          tray_type: '',
          tray_sub_brands: '',
          tray_color: '00000000',
          nozzle_temp_min: 0,
          nozzle_temp_max: 0,
          setting_id: ''
        }
      }]
    case 'loadAmsFilament':
      return [{
        print: {
          command: 'ams_change_filament',
          curr_temp: command.nozzleTemp,
          tar_temp: command.nozzleTemp,
          ams_id: command.amsId,
          target: resolveAmsChangeFilamentTarget(command.amsId, command.slotId),
          slot_id: command.slotId,
          ...(command.extruderId != null ? { extruder_id: command.extruderId } : {})
        }
      }]
    case 'unloadAmsFilament':
      return [{
        print: {
          command: 'ams_change_filament',
          curr_temp: command.nozzleTemp,
          tar_temp: command.nozzleTemp,
          ams_id: command.amsId,
          target: VIRTUAL_TRAY_UNLOAD_TARGET,
          slot_id: VIRTUAL_TRAY_UNLOAD_TARGET,
          ...(command.extruderId != null ? { extruder_id: command.extruderId } : {})
        }
      }]
    case 'setExternalSpool':
      return [{
        print: {
          command: 'ams_filament_setting',
          ams_id: command.amsId,
          tray_id: VIRTUAL_TRAY_SETTING_ID,
          tray_info_idx: command.trayInfoIdx,
          tray_color: command.trayColor.toUpperCase(),
          tray_type: command.trayType,
          nozzle_temp_min: command.nozzleTempMin,
          nozzle_temp_max: command.nozzleTempMax,
          setting_id: ''
        }
      }]
    case 'resetExternalSpool':
      return [{
        print: {
          command: 'ams_filament_setting',
          ams_id: command.amsId,
          tray_id: VIRTUAL_TRAY_SETTING_ID,
          tray_info_idx: '',
          tray_type: '',
          tray_sub_brands: '',
          tray_color: '00000000',
          nozzle_temp_min: 0,
          nozzle_temp_max: 0,
          setting_id: ''
        }
      }]
    case 'loadExternalSpool':
      return [{
        print: {
          command: 'ams_change_filament',
          curr_temp: command.nozzleTemp,
          tar_temp: command.nozzleTemp,
          ams_id: command.amsId,
          target: command.amsId,
          slot_id: 0,
          ...(command.extruderId != null ? { extruder_id: command.extruderId } : {})
        }
      }]
    case 'unloadExternalSpool':
      return [{
        print: {
          command: 'ams_change_filament',
          curr_temp: command.nozzleTemp,
          tar_temp: command.nozzleTemp,
          ams_id: command.amsId,
          target: VIRTUAL_TRAY_UNLOAD_TARGET,
          slot_id: VIRTUAL_TRAY_UNLOAD_TARGET,
          ...(command.extruderId != null ? { extruder_id: command.extruderId } : {})
        }
      }]
    case 'selectAmsPressureAdvanceProfile': {
      const context = resolvePressureAdvanceCommandContext(status, command.amsId)
      return [{
        print: {
          command: 'extrusion_cali_sel',
          tray_id: resolveCommandTrayId(status, command.amsId, command.slotId),
          ams_id: command.amsId,
          slot_id: command.slotId,
          cali_idx: command.caliIdx,
          filament_id: command.filamentId,
          extruder_id: context.extruderId,
          nozzle_id: formatPressureAdvanceNozzleId(context.nozzleTypeCode, context.nozzleDiameter),
          nozzle_diameter: context.nozzleDiameter
        }
      }]
    }
    case 'createAmsPressureAdvanceProfile': {
      const context = resolvePressureAdvanceCommandContext(status, command.amsId)
      return [{
        print: {
          command: 'extrusion_cali_set',
          nozzle_diameter: command.nozzleDiameter,
          filaments: [
            {
              tray_id: resolveCommandTrayId(status, command.amsId, command.slotId),
              ams_id: command.amsId,
              slot_id: command.slotId,
              extruder_id: command.extruderId,
              filament_id: command.filamentId,
              setting_id: command.settingId,
              name: command.profileName,
              k_value: command.kValue.toFixed(6),
              n_coef: '1.400000',
              nozzle_id: formatPressureAdvanceNozzleId(context.nozzleTypeCode, command.nozzleDiameter),
              nozzle_diameter: command.nozzleDiameter
            }
          ]
        }
      }]
    }
    case 'deleteAmsPressureAdvanceProfile': {
      const context = resolvePressureAdvanceCommandContext(status, command.amsId)
      return [{
        print: {
          command: 'extrusion_cali_del',
          extruder_id: context.extruderId,
          nozzle_id: formatPressureAdvanceNozzleId(context.nozzleTypeCode, context.nozzleDiameter),
          filament_id: command.filamentId,
          cali_idx: command.caliIdx,
          nozzle_diameter: context.nozzleDiameter
        }
      }]
    }
    case 'setAmsKValue': {
      // BambuStudio saves manual PA entries with a direct `tray_id`/`k_value`
      // payload rather than the `filaments[]` structure.
      return [{
        print: {
          command: 'extrusion_cali_set',
          tray_id: resolveCommandTrayId(status, command.amsId, command.slotId),
          k_value: command.kValue.toFixed(6),
          n_coef: '1.400000'
        }
      }]
    }
    default:
      return []
  }
}

function printOptionToMqttPayload(
  command: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'setPrintOption' }>
): Record<string, unknown> {
  switch (command.option) {
    case 'aiMonitoring':
      return xcamPrintOptionPayload('printing_monitor', command.enabled, command.sensitivity ?? 'medium')
    case 'spaghettiDetection':
      return xcamPrintOptionPayload('spaghetti_detector', command.enabled, requireDetectionSensitivity(command))
    case 'purgeChutePileupDetection':
      return xcamPrintOptionPayload('pileup_detector', command.enabled, requireDetectionSensitivity(command))
    case 'nozzleClumpingDetection':
      return xcamPrintOptionPayload('clump_detector', command.enabled, requireDetectionSensitivity(command))
    case 'airPrintingDetection':
      return xcamPrintOptionPayload('airprint_detector', command.enabled, requireDetectionSensitivity(command))
    case 'firstLayerInspection':
      return xcamPrintOptionPayload('first_layer_inspector', command.enabled)
    case 'autoRecovery':
      return {
        print: {
          command: 'print_option',
          option: command.enabled ? 1 : 0,
          auto_recovery: command.enabled
        }
      }
    case 'promptSound':
      return {
        print: {
          command: 'print_option',
          sound_enable: command.enabled
        }
      }
    case 'filamentTangleDetection':
      return {
        print: {
          command: 'print_option',
          filament_tangle_detect: command.enabled
        }
      }
  }
}

function xcamPrintOptionPayload(
  moduleName: string,
  enabled: boolean,
  sensitivity?: 'never_halt' | 'low' | 'medium' | 'high'
): Record<string, unknown> {
  return {
    xcam: {
      command: 'xcam_control_set',
      module_name: moduleName,
      control: enabled,
      enable: enabled,
      print_halt: sensitivity === 'never_halt' ? false : true,
      ...(sensitivity ? { halt_print_sensitivity: sensitivity } : {})
    }
  }
}

function requireDetectionSensitivity(
  command: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'setPrintOption' }>
): 'low' | 'medium' | 'high' {
  if (!command.sensitivity || command.sensitivity === 'never_halt') {
    throw badRequest(`${command.option} requires a sensitivity of low, medium, or high`)
  }
  return command.sensitivity
}

/**
 * Resolves the extruder/nozzle context for a pressure-advance command from
 * live status. Shared by `commandToMqttPayloads` and the pressure-advance
 * profiles route.
 */
export function resolvePressureAdvanceCommandContext(
  status: ReturnType<typeof printerManager.getStatus>,
  amsId: number
): { extruderId: number; nozzleDiameter: string; nozzleTypeCode: string | null } {
  const extruderId = amsId === 254
    ? 1
    : amsId === 255
      ? 0
      : status?.ams.find((unit) => unit.unitId === amsId)?.nozzleId ?? 0

  const nozzle = status?.nozzles.find((entry) => entry.extruderId === extruderId)
  return {
    extruderId,
    nozzleDiameter: nozzle?.diameter ?? '0.4',
    nozzleTypeCode: nozzle?.typeCode ?? 'HS00'
  }
}

function formatPressureAdvanceNozzleId(nozzleTypeCode: string | null, nozzleDiameter: string): string {
  return `${nozzleTypeCode ?? 'HS00'}-${nozzleDiameter}`
}

function lightNodeToMqttNode(node: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'light' }>['node']): string {
  switch (node) {
    case 'chamber':
      return 'chamber_light'
    case 'heatbed':
      return 'heatbed_light'
  }
}

function buildLightCommandPayloads(
  model: Printer['model'],
  command: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'light' }>,
): Array<{ system: { command: 'ledctrl'; led_node: string; led_mode: 'on' | 'off'; led_on_time: number; led_off_time: number; loop_times: 0; interval_time: 0 } }> {
  const nodes: Array<'chamber_light' | 'chamber_light2' | 'heatbed_light'> = command.node === 'chamber' && supportsPrinterSecondaryChamberLight(model)
    ? ['chamber_light', 'chamber_light2'] as const
    : [lightNodeToMqttNode(command.node) as 'chamber_light' | 'heatbed_light']

  return nodes.map((node) => ({
    system: {
      command: 'ledctrl',
      led_node: node,
      led_mode: command.on ? 'on' : 'off',
      led_on_time: node === 'heatbed_light' ? 0 : 500,
      led_off_time: node === 'heatbed_light' ? 0 : 500,
      loop_times: 0,
      interval_time: 0
    }
  }))
}

function fanGcodeSelector(fan: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'setFanSpeed' }>['fan']): string {
  switch (fan) {
    case 'part':
      return 'P1'
    case 'aux':
      return 'P2'
    case 'chamber':
      return 'P3'
  }
}

function fanIndexSelector(fan: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'setFanSpeed' }>['fan']): number {
  switch (fan) {
    case 'part':
      return 1
    case 'aux':
      return 2
    case 'chamber':
      return 3
  }
}

function fanSpeedPayload(
  fan: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'setFanSpeed' }>['fan'],
  percent: number,
  status: ReturnType<typeof printerManager.getStatus>
): Record<string, unknown> {
  return status?.commandTransport.newFanControl === true
    ? { print: { command: 'set_fan', fan_index: fanIndexSelector(fan), speed: Math.round(percent * 10) } }
    : { print: { command: 'gcode_line', param: `M106 ${fanGcodeSelector(fan)} S${Math.round((255 * percent) / 100)}\n` } }
}

function bedTemperaturePayload(
  target: number,
  status: ReturnType<typeof printerManager.getStatus>
): Record<string, unknown> {
  return status?.commandTransport.mqttBedTemperature === true
    ? { print: { command: 'set_bed_temp', temp: target } }
    : { print: { command: 'gcode_line', param: `M140 S${target}\n` } }
}

function motionPayload(
  axis: 'X' | 'Y' | 'Z',
  distanceMm: -10 | -1 | 1 | 10,
  model: ReturnType<typeof printerModelSchema.parse>,
  status: ReturnType<typeof printerManager.getStatus>
): Record<string, unknown> {
  return status?.commandTransport.mqttAxisControl === true
    ? {
        print: {
          command: 'xyz_ctrl',
          axis,
          dir: distanceMm > 0 ? 1 : -1,
          mode: Math.abs(distanceMm) >= 10 ? 1 : 0
        }
      }
    : {
        print: {
          command: 'gcode_line',
          param: legacyMotionGcode(axis, distanceMm, model)
        }
      }
}

function homingPayload(status: ReturnType<typeof printerManager.getStatus>): Record<string, unknown> {
  return status?.commandTransport.mqttHoming === true
    ? { print: { command: 'back_to_center' } }
    : { print: { command: 'gcode_line', param: 'G28\n' } }
}

function legacyMotionGcode(
  axis: 'X' | 'Y' | 'Z',
  distanceMm: -10 | -1 | 1 | 10,
  model: ReturnType<typeof printerModelSchema.parse>
): string {
  const adjustedDistance = legacyMotionDistance(axis, distanceMm, model)
  const feedrate = axis === 'Z' ? 900 : 3000
  return `M211 S \nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91 \nG1 ${axis}${adjustedDistance.toFixed(1)} F${feedrate}\nM1002 pop_ref_mode\nM211 R\n`
}

function legacyMotionDistance(
  axis: 'X' | 'Y' | 'Z',
  distanceMm: number,
  model: ReturnType<typeof printerModelSchema.parse>
): number {
  // On a bed-slinger (non-CoreXY, e.g. A1) the bed moves for Y and the nozzle
  // for Z, so a "move +" jog in the UI is a negative G-code delta on those axes;
  // CoreXY machines move the toolhead directly and need no inversion.
  if (usesCoreXyMotionSystem(model)) return distanceMm
  if (axis === 'Y' || axis === 'Z') return -distanceMm
  return distanceMm
}
