/**
 * Maps printer commands to permission scopes and safe audit descriptions.
 *
 * Audit metadata omits filament secrets. Calibration uses its own success
 * path to include the durable job id in the audit record.
 */
import { printerCommandSchema, PRINTERS_CONTROL_CALIBRATE_SCOPE, PRINTERS_CONTROL_HMS_CLEAR_SCOPE, PRINTERS_CONTROL_MANUAL_CONTROLS_SCOPE, PRINTERS_CONTROL_REFRESH_SCOPE, PRINTERS_MANAGE_AMS_SCOPE, PRINTERS_MANAGE_SETTINGS_SCOPE, type PermissionScope } from '@printstream/shared'

export function getPrinterCommandPermission(
  command: ReturnType<typeof printerCommandSchema.parse>
): PermissionScope {
  switch (command.type) {
    case 'refresh':
      return PRINTERS_CONTROL_REFRESH_SCOPE
    case 'calibrate':
      return PRINTERS_CONTROL_CALIBRATE_SCOPE
    case 'clearHmsErrors':
      return PRINTERS_CONTROL_HMS_CLEAR_SCOPE
    case 'setPrintOption':
    case 'setPurifyAirAtPrintEnd':
    case 'setOpenDoorDetection':
    case 'setSmartNozzleBlobDetection':
    case 'setCameraResolution':
      return PRINTERS_MANAGE_SETTINGS_SCOPE
    case 'setAmsUserSettings':
    case 'setAmsFilamentBackup':
    case 'switchAmsFirmware':
    case 'resetAmsOrder':
    case 'startAmsDrying':
    case 'stopAmsDrying':
    case 'rescanAmsSlot':
    case 'setAmsSlot':
    case 'resetAmsSlot':
    case 'loadAmsFilament':
    case 'unloadAmsFilament':
    case 'setExternalSpool':
    case 'resetExternalSpool':
    case 'loadExternalSpool':
    case 'unloadExternalSpool':
    case 'selectAmsPressureAdvanceProfile':
    case 'createAmsPressureAdvanceProfile':
    case 'deleteAmsPressureAdvanceProfile':
    case 'setAmsKValue':
      return PRINTERS_MANAGE_AMS_SCOPE
    default:
      return PRINTERS_CONTROL_MANUAL_CONTROLS_SCOPE
  }
}

/**
 * Maps a printer command to a readable audit action/resource/summary. Every
 * command type produces an entry so the durable audit trail stays readable;
 * the `:id/command` handler attaches the command type (and, for AMS slot
 * commands, the unit/slot indices, never filament secrets) as metadata.
 *
 * `calibrate` is intentionally absent: it is audited on its own success path
 * (with the calibration option + job id) before this helper runs.
 */
export function describePrinterCommandAudit(
  command: ReturnType<typeof printerCommandSchema.parse>
): { action: string; resource: string; summary: string } | null {
  switch (command.type) {
    case 'pause':
      return { action: 'pause-print', resource: 'print job', summary: 'Paused print' }
    case 'resume':
      return { action: 'resume-print', resource: 'print job', summary: 'Resumed print' }
    case 'ignoreHmsError':
      return { action: 'resume-print', resource: 'print job', summary: 'Ignored printer warning and resumed print' }
    case 'retryAmsFilamentChange':
      return { action: 'resume-print', resource: 'filament change', summary: 'Retried filament change step' }
    case 'confirmAmsFilamentExtruded':
      return { action: 'resume-print', resource: 'filament change', summary: 'Confirmed filament extrusion and continued change' }
    case 'stop':
      return { action: 'stop-print', resource: 'print job', summary: 'Stopped print' }
    case 'skipObjects':
      return { action: 'skip-objects', resource: 'print job', summary: 'Skipped print objects' }
    case 'clearHmsErrors':
      return { action: 'clear-hms-errors', resource: 'printer', summary: 'Cleared printer HMS errors' }
    case 'refresh':
      return { action: 'refresh-printer', resource: 'printer', summary: 'Refreshed printer connection' }
    case 'light':
      return { action: 'set-printer-light', resource: 'printer', summary: `Turned ${command.on ? 'on' : 'off'} the ${command.node} light` }
    case 'setAirductMode':
      return { action: 'set-air-management', resource: 'printer', summary: 'Changed air management mode' }
    case 'setPrintOption':
      return { action: 'set-print-option', resource: 'printer', summary: `Changed print option ${command.option} (${command.enabled ? 'on' : 'off'})` }
    case 'setPurifyAirAtPrintEnd':
      return { action: 'set-print-option', resource: 'printer', summary: `Changed end-of-print air purification to ${command.mode}` }
    case 'setOpenDoorDetection':
      return { action: 'set-print-option', resource: 'printer', summary: `Changed open-door detection to ${command.mode}` }
    case 'setSmartNozzleBlobDetection':
      return { action: 'set-print-option', resource: 'printer', summary: `Changed smart nozzle blob detection to ${command.mode}` }
    case 'setCameraResolution':
      return { action: 'set-camera-resolution', resource: 'printer', summary: `Changed camera resolution to ${command.resolution}` }
    case 'controlNozzleRack':
      return { action: 'control-nozzle-rack', resource: 'printer', summary: `Requested nozzle rack action ${command.action}` }
    case 'setNozzleTemperature':
      return { action: 'set-nozzle-temperature', resource: 'printer', summary: `Set nozzle temperature to ${command.target}C` }
    case 'setBedTemperature':
      return { action: 'set-bed-temperature', resource: 'printer', summary: `Set bed temperature to ${command.target}C` }
    case 'setChamberTemperature':
      return { action: 'set-chamber-temperature', resource: 'printer', summary: `Set chamber temperature to ${command.target}C` }
    case 'setFanSpeed':
      return { action: 'set-fan-speed', resource: 'printer', summary: `Set ${command.fan} fan to ${command.percent}%` }
    case 'setPrintSpeed':
      return { action: 'set-print-speed', resource: 'print job', summary: `Set print speed to ${command.level}` }
    case 'moveAxis':
      return { action: 'move-axis', resource: 'printer', summary: `Jogged ${command.axis} axis by ${command.distanceMm}mm` }
    case 'homeAxes':
      return { action: 'home-axes', resource: 'printer', summary: 'Homed printer axes' }
    case 'extrudeFilament':
      return { action: 'extrude-filament', resource: 'printer', summary: `Extruded/retracted filament by ${command.distanceMm}mm` }
    case 'setAmsUserSettings':
      return { action: 'set-ams-settings', resource: 'ams', summary: 'Updated AMS user settings' }
    case 'setAmsFilamentBackup':
      return { action: 'set-ams-filament-backup', resource: 'ams', summary: `Turned AMS filament backup ${command.enabled ? 'on' : 'off'}` }
    case 'switchAmsFirmware':
      return { action: 'switch-ams-firmware', resource: 'ams', summary: `Switched the AMS chain to firmware ${command.firmwareId}` }
    case 'resetAmsOrder':
      return { action: 'reset-ams-order', resource: 'ams', summary: 'Reset the AMS id sequence' }
    case 'startAmsDrying':
      return { action: 'start-ams-drying', resource: 'ams', summary: 'Started AMS filament drying' }
    case 'stopAmsDrying':
      return { action: 'stop-ams-drying', resource: 'ams', summary: 'Stopped AMS filament drying' }
    case 'rescanAmsSlot':
      return { action: 'rescan-ams-slot', resource: 'ams', summary: 'Rescanned an AMS slot' }
    case 'setAmsSlot':
      return { action: 'set-ams-slot', resource: 'ams', summary: 'Configured an AMS slot' }
    case 'resetAmsSlot':
      return { action: 'reset-ams-slot', resource: 'ams', summary: 'Reset an AMS slot' }
    case 'loadAmsFilament':
      return { action: 'load-ams-filament', resource: 'ams', summary: 'Loaded filament from an AMS slot' }
    case 'unloadAmsFilament':
      return { action: 'unload-ams-filament', resource: 'ams', summary: 'Unloaded filament from an AMS slot' }
    case 'setExternalSpool':
      return { action: 'set-external-spool', resource: 'ams', summary: 'Configured the external spool' }
    case 'resetExternalSpool':
      return { action: 'reset-external-spool', resource: 'ams', summary: 'Reset the external spool' }
    case 'loadExternalSpool':
      return { action: 'load-external-spool', resource: 'ams', summary: 'Loaded filament from the external spool' }
    case 'unloadExternalSpool':
      return { action: 'unload-external-spool', resource: 'ams', summary: 'Unloaded filament from the external spool' }
    case 'selectAmsPressureAdvanceProfile':
      return { action: 'select-ams-pressure-advance-profile', resource: 'ams', summary: 'Selected an AMS pressure-advance profile' }
    case 'createAmsPressureAdvanceProfile':
      return { action: 'create-ams-pressure-advance-profile', resource: 'ams', summary: `Created AMS pressure-advance profile ${command.profileName}` }
    case 'deleteAmsPressureAdvanceProfile':
      return { action: 'delete-ams-pressure-advance-profile', resource: 'ams', summary: 'Deleted an AMS pressure-advance profile' }
    case 'setAmsKValue':
      return { action: 'set-ams-k-value', resource: 'ams', summary: `Set AMS pressure-advance K value to ${command.kValue}` }
    default:
      return null
  }
}

/**
 * Non-secret metadata to attach for a printer command. Includes AMS unit/slot
 * (and external-spool tray) indices where relevant, but never filament
 * secrets such as tray colors or filament preset ids.
 */
export function describePrinterCommandAuditMetadata(
  command: ReturnType<typeof printerCommandSchema.parse>
): Record<string, unknown> {
  switch (command.type) {
    case 'skipObjects':
      return { objectIds: command.objectIds }
    case 'light':
      return { lightNode: command.node, on: command.on }
    case 'setPrintOption':
      return { option: command.option, enabled: command.enabled }
    case 'setPurifyAirAtPrintEnd':
    case 'setOpenDoorDetection':
    case 'setSmartNozzleBlobDetection':
      return { mode: command.mode }
    case 'setCameraResolution':
      return { resolution: command.resolution }
    case 'controlNozzleRack':
      return { action: command.action }
    case 'setFanSpeed':
      return { fan: command.fan, percent: command.percent }
    case 'setNozzleTemperature':
      return { target: command.target, extruderId: command.extruderId }
    case 'setBedTemperature':
    case 'setChamberTemperature':
      return { target: command.target }
    case 'setPrintSpeed':
      return { level: command.level }
    case 'moveAxis':
      return { axis: command.axis, distanceMm: command.distanceMm }
    case 'extrudeFilament':
      return { distanceMm: command.distanceMm, extruderId: command.extruderId }
    case 'setAmsFilamentBackup':
      return { enabled: command.enabled }
    case 'switchAmsFirmware':
      return { firmwareId: command.firmwareId }
    case 'startAmsDrying':
      return {
        amsId: command.amsId,
        temperature: command.temperature,
        durationHours: command.durationHours,
        acknowledgedRisks: command.acknowledgeRisks
      }
    case 'stopAmsDrying':
      return { amsId: command.amsId }
    case 'rescanAmsSlot':
    case 'setAmsSlot':
    case 'resetAmsSlot':
    case 'loadAmsFilament':
    case 'unloadAmsFilament':
    case 'selectAmsPressureAdvanceProfile':
    case 'deleteAmsPressureAdvanceProfile':
    case 'setAmsKValue':
      return { amsId: command.amsId, slotId: command.slotId }
    case 'createAmsPressureAdvanceProfile':
      return { amsId: command.amsId, slotId: command.slotId, profileName: command.profileName }
    case 'setExternalSpool':
    case 'resetExternalSpool':
    case 'loadExternalSpool':
    case 'unloadExternalSpool':
      return { amsId: command.amsId }
    default:
      return {}
  }
}
