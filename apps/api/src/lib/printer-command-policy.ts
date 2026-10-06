/**
 * Command availability and model-capability checks before MQTT dispatch.
 *
 * Commands are accepted only when the live printer state supports the requested
 * action. The HTTP route applies these checks after parsing and authorization.
 */
import {
  PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C,
  getAmsLoadFilamentAvailability, getAmsRescanAvailability,
  getAmsUnloadFilamentAvailability, getConfirmAmsFilamentExtrudedAvailability,
  getExternalSpoolLoadAvailability, getExternalSpoolUnloadAvailability,
  getIgnoreHmsErrorAvailability, getNozzleRackControlAvailability,
  canUseExtruderControl, canUseMotionControl, canUsePrintSpeedControl,
  getPrinterCalibrationCapabilities, getPrinterChamberTemperatureMax,
  getPauseAvailability, getPrinterControlCapabilities, isPrinterActiveJobStage,
  supportsAmsSettingsReorder, getRetryAmsFilamentChangeAvailability,
  getResumeAvailability, getStopAvailability, printerCommandSchema,
  printerModelSchema, supportsPrinterAirductMode, validateAmsDryingStart
} from '@printstream/shared'
import { badRequest } from './http-error.js'
import { printerManager } from './printer-manager.js'

export function validateCalibrationCommand(
  model: string,
  command: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'calibrate' }>
): void {
  const normalizedModel = printerModelSchema.safeParse(model).success ? printerModelSchema.parse(model) : 'unknown'
  const capabilities = getPrinterCalibrationCapabilities(normalizedModel)
  const unsupported: string[] = []
  if (command.xcam && !capabilities.xcam) unsupported.push('Micro Lidar calibration')
  if (command.bedLeveling && !capabilities.bedLeveling) unsupported.push('Auto bed leveling')
  if (command.vibration && !capabilities.vibration) unsupported.push('Vibration compensation')
  if (command.motorNoise && !capabilities.motorNoise) unsupported.push('Motor noise cancellation')
  if (command.nozzleOffset && !capabilities.nozzleOffset) unsupported.push('Nozzle offset calibration')
  if (command.highTempHeatbed && !capabilities.highTempHeatbed) unsupported.push('High-temperature bed leveling')
  if (command.nozzleClumping && !capabilities.nozzleClumping) unsupported.push('Nozzle clumping detection')
  if (unsupported.length > 0) {
    throw badRequest(`${unsupported.join(', ')} not supported on ${normalizedModel}`)
  }
}

export function validatePrinterControlCommand(
  model: string,
  status: ReturnType<typeof printerManager.getStatus>,
  command: ReturnType<typeof printerCommandSchema.parse>
): void {
  const normalizedModel = printerModelSchema.safeParse(model).success ? printerModelSchema.parse(model) : 'unknown'
  const capabilities = getPrinterControlCapabilities(normalizedModel)

  switch (command.type) {
    case 'pause':
      requirePrinterActionAvailability(getPauseAvailability(status))
      return
    case 'resume':
      requirePrinterActionAvailability(getResumeAvailability(status))
      return
    case 'ignoreHmsError':
      requirePrinterActionAvailability(getIgnoreHmsErrorAvailability(status))
      return
    case 'retryAmsFilamentChange':
      requirePrinterActionAvailability(getRetryAmsFilamentChangeAvailability(status))
      return
    case 'confirmAmsFilamentExtruded':
      requirePrinterActionAvailability(getConfirmAmsFilamentExtrudedAvailability(status))
      return
    case 'stop':
      requirePrinterActionAvailability(getStopAvailability(status))
      return
    case 'light':
      requireLiveControlConnection(status, 'Light control')
      if (command.node !== 'chamber' && status?.lightCapabilities[command.node] !== true) {
        throw badRequest(`${lightNodeLabel(command.node)} is not available on this printer`)
      }
      return
    case 'setAirductMode':
      requireLiveControlConnection(status, 'Air management')
      if (!supportsPrinterAirductMode(normalizedModel)) {
        throw badRequest(`${normalizedModel} does not support air management`)
      }
      return
    case 'setPrintOption':
      requireLiveControlConnection(status, 'Printer settings')
      if (status?.printOptions[command.option]?.supported !== true) {
        throw badRequest('This printer has not reported support for that setting')
      }
      return
    case 'setPurifyAirAtPrintEnd':
      requireLiveControlConnection(status, 'Printer settings')
      if (status?.printOptions.purifyAirAtPrintEnd?.supported !== true) {
        throw badRequest('This printer has not reported support for end-of-print air purification')
      }
      return
    case 'setOpenDoorDetection':
      requireLiveControlConnection(status, 'Printer settings')
      if (status?.printOptions.openDoorDetection?.supported !== true) {
        throw badRequest('This printer has not reported support for open-door detection')
      }
      return
    case 'setSmartNozzleBlobDetection':
      requireLiveControlConnection(status, 'Printer settings')
      if (status?.printOptions.smartNozzleBlobDetection?.supported !== true) {
        throw badRequest('This printer has not reported support for smart nozzle blob detection')
      }
      return
    case 'setCameraResolution':
      requireLiveControlConnection(status, 'Camera settings')
      if (
        status?.printOptions.cameraResolution?.supported !== true
        || !status.printOptions.cameraResolution.available.includes(command.resolution)
      ) {
        throw badRequest('This printer has not reported that camera resolution as available')
      }
      return
    case 'controlNozzleRack':
      requirePrinterActionAvailability(getNozzleRackControlAvailability(status))
      return
    case 'setNozzleTemperature':
      requireLiveControlConnection(status, 'Temperature control')
      if (!capabilities.nozzleTemperature) throw badRequest(`${normalizedModel} does not support nozzle temperature control`)
      if (command.extruderId > 0 && !capabilities.dualNozzles) {
        throw badRequest('This printer only has one controllable nozzle')
      }
      return
    case 'setBedTemperature':
      requireLiveControlConnection(status, 'Temperature control')
      if (!capabilities.bedTemperature) throw badRequest(`${normalizedModel} does not support bed temperature control`)
      return
    case 'setChamberTemperature': {
      requireLiveControlConnection(status, 'Temperature control')
      if (!capabilities.chamberTemperature) {
        throw badRequest(`${normalizedModel} does not support chamber temperature control`)
      }
      const chamberTargetMax = getPrinterChamberTemperatureMax(normalizedModel)
      if (command.target > chamberTargetMax) {
        throw badRequest(`${normalizedModel} chamber temperature must be ${chamberTargetMax}C or lower`)
      }
      return
    }
    case 'setFanSpeed':
      requireLiveControlConnection(status, 'Fan control')
      if (command.fan === 'aux' && !capabilities.auxFan) {
        throw badRequest(`${normalizedModel} does not support auxiliary fan control`)
      }
      if (command.fan === 'chamber' && !capabilities.chamberFan) {
        throw badRequest(`${normalizedModel} does not support chamber fan control`)
      }
      if (command.fan === 'part' && !capabilities.partFan) {
        throw badRequest(`${normalizedModel} does not support part fan control`)
      }
      return
    case 'setPrintSpeed':
      requireLiveControlConnection(status, 'Print speed control')
      if (!capabilities.printSpeed) throw badRequest(`${normalizedModel} does not support print speed control`)
      if (!canUsePrintSpeedControl(status)) {
        throw badRequest('Print speed can only be changed while a print is active')
      }
      return
    case 'moveAxis':
    case 'homeAxes':
      requireLiveControlConnection(status, 'Motion control')
      if (!capabilities.motion) throw badRequest(`${normalizedModel} does not support motion control`)
      if (!canUseMotionControl(status)) {
        throw badRequest('Motion control is only available while the printer is idle')
      }
      return
    case 'extrudeFilament':
      requireLiveControlConnection(status, 'Extruder control')
      if (!capabilities.extruderControl) throw badRequest(`${normalizedModel} does not support extruder control`)
      if (command.extruderId > 0 && !capabilities.dualNozzles) {
        throw badRequest('This printer only has one controllable nozzle')
      }
      if (!canUseExtruderControl(status, command.extruderId)) {
        throw badRequest(`Extruder control requires an idle printer with the nozzle heated to at least ${PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C}C`)
      }
      return
    case 'selectAmsPressureAdvanceProfile':
    case 'createAmsPressureAdvanceProfile':
    case 'deleteAmsPressureAdvanceProfile':
    case 'setAmsKValue':
      requireLiveControlConnection(status, 'Pressure advance control')
      return
    case 'startAmsDrying': {
      requireLiveControlConnection(status, 'AMS drying')
      const unit = status?.ams.find((entry) => entry.unitId === command.amsId)
      if (!unit) throw badRequest('AMS unit not found on this printer')
      const rejection = validateAmsDryingStart(unit, command)
      if (rejection) throw badRequest(rejection)
      return
    }
    case 'rescanAmsSlot':
      requirePrinterActionAvailability(getAmsRescanAvailability(status, command.amsId, command.slotId))
      return
    case 'loadAmsFilament':
      requirePrinterActionAvailability(getAmsLoadFilamentAvailability(status, command.amsId, command.slotId))
      return
    case 'unloadAmsFilament':
      requirePrinterActionAvailability(getAmsUnloadFilamentAvailability(status, command.amsId, command.slotId))
      return
    case 'loadExternalSpool':
      requirePrinterActionAvailability(getExternalSpoolLoadAvailability(status, command.amsId))
      return
    case 'unloadExternalSpool':
      requirePrinterActionAvailability(getExternalSpoolUnloadAvailability(status, command.amsId))
      return
    case 'switchAmsFirmware':
      throw badRequest(
        'AMS type switching is unavailable until PrintStream can verify that no filament is loaded in the extruder.'
      )
    case 'resetAmsOrder':
      requireLiveControlConnection(status, 'Arranging AMS order')
      if (!supportsAmsSettingsReorder(normalizedModel)) {
        throw badRequest('This printer does not support arranging AMS order.')
      }
      if (isPrinterActiveJobStage(status?.stage)) {
        throw badRequest('Finish or stop the print before resetting the AMS id sequence.')
      }
      return
    default:
      return
  }
}

function requirePrinterActionAvailability(result: { allowed: boolean; reason: string | null }): void {
  if (!result.allowed) throw badRequest(result.reason ?? 'Command is not currently available')
}

export function requireLiveControlConnection(status: ReturnType<typeof printerManager.getStatus>, label: string): void {
  if (status?.online !== true) {
    throw badRequest(`${label} is only available while the printer is connected`)
  }
}

function lightNodeLabel(node: Extract<ReturnType<typeof printerCommandSchema.parse>, { type: 'light' }>['node']): string {
  switch (node) {
    case 'chamber':
      return 'Chamber light'
    case 'heatbed':
      return 'Heatbed light'
  }
}
