/**
 * Helpers for Bambu calibration command encoding and replay metadata.
 */
import type { PrinterCommand } from '@printstream/shared'

export type CalibrationCommand = Extract<PrinterCommand, { type: 'calibrate' }>

export function calibrationOption(command: CalibrationCommand): number {
  let option = 0
  if (command.xcam) option |= 1 << 0
  if (command.bedLeveling) option |= 1 << 1
  if (command.vibration) option |= 1 << 2
  if (command.motorNoise) option |= 1 << 3
  if (command.nozzleOffset) option |= 1 << 4
  if (command.highTempHeatbed) option |= 1 << 5
  if (command.nozzleClumping) option |= 1 << 6
  return option
}

export function calibrationCommandFromOption(option: number): CalibrationCommand {
  return {
    type: 'calibrate',
    xcam: (option & (1 << 0)) !== 0,
    bedLeveling: (option & (1 << 1)) !== 0,
    vibration: (option & (1 << 2)) !== 0,
    motorNoise: (option & (1 << 3)) !== 0,
    nozzleOffset: (option & (1 << 4)) !== 0,
    highTempHeatbed: (option & (1 << 5)) !== 0,
    nozzleClumping: (option & (1 << 6)) !== 0
  }
}