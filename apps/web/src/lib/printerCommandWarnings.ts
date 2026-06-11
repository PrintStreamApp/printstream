import type { PrinterCommand, PrinterStage, PrinterStatus } from '@printstream/shared'

import {
  CHAMBER_LIGHT_OFF_CONFIRMATION_MESSAGE,
  shouldConfirmChamberLightTurnOff
} from './chamberLightWarning'

export const STOP_PRINT_CONFIRMATION_TITLE = 'Cancel print'
export const STOP_PRINT_CONFIRMATION_MESSAGE = 'Are you sure you want to stop this print?'
export const CONTINUE_PRINT_CONFIRMATION_TITLE = 'Continue print'
export const AUTO_HOMING_CONFIRMATION_TITLE = 'Auto homing'
export const AUTO_HOMING_CONFIRMATION_MESSAGE = 'Are you sure you want to trigger auto homing?'
export const FAN_SPEED_DURING_PRINT_WARNING_MESSAGE = 'Changing fan speed during printing may affect print quality, please choose carefully.'
export const CHAMBER_TEMPERATURE_COOLING_MODE_WARNING_MESSAGE = 'Chamber temperature cannot be changed in cooling mode while printing.'
export const CHAMBER_TEMPERATURE_HEATING_SWITCH_WARNING_MESSAGE = 'If the chamber temperature exceeds 40°C, the system will automatically switch to heating mode. Please confirm whether to switch.'

export interface PrinterCommandPromptOptions {
  fanSpeedWarningSeen?: boolean
}

export type PrinterCommandPrompt =
  | {
      kind: 'confirm'
      title: string | null
      message: string
      confirmLabel: string
      cancelLabel: string
      color?: 'primary' | 'warning' | 'danger'
      rememberAs?: 'fanSpeedDuringPrint'
    }
  | {
      kind: 'notice'
      title: string | null
      message: string
      acknowledgeLabel: string
    }

export function getPrinterCommandPrompt(
  status: Pick<PrinterStatus, 'stage' | 'ductMode' | 'chamberLightOffRequiresConfirm' | 'deviceError'> | null | undefined,
  command: PrinterCommand,
  options: PrinterCommandPromptOptions = {}
): PrinterCommandPrompt | null {
  if (shouldConfirmChamberLightTurnOff(status, command)) {
    return {
      kind: 'confirm',
      title: null,
      message: CHAMBER_LIGHT_OFF_CONFIRMATION_MESSAGE,
      cancelLabel: 'Keep it On',
      confirmLabel: 'Still turn it Off',
      color: 'warning'
    }
  }

  if (command.type === 'stop') {
    return {
      kind: 'confirm',
      title: STOP_PRINT_CONFIRMATION_TITLE,
      message: STOP_PRINT_CONFIRMATION_MESSAGE,
      cancelLabel: 'No',
      confirmLabel: 'Yes',
      color: 'danger'
    }
  }

  if (command.type === 'homeAxes') {
    return {
      kind: 'confirm',
      title: AUTO_HOMING_CONFIRMATION_TITLE,
      message: AUTO_HOMING_CONFIRMATION_MESSAGE,
      cancelLabel: 'Cancel',
      confirmLabel: 'Homing',
      color: 'warning'
    }
  }

  if (command.type === 'ignoreHmsError' && status?.deviceError != null) {
    return {
      kind: 'confirm',
      title: CONTINUE_PRINT_CONFIRMATION_TITLE,
      message: status.deviceError.message
        ? `${status.deviceError.message} Continue anyway?`
        : 'The printer reported a warning before pausing. Continue anyway?',
      cancelLabel: 'Cancel',
      confirmLabel: 'Continue',
      color: 'warning'
    }
  }

  if (
    command.type === 'setFanSpeed'
    && isPrintingTaskStage(status?.stage)
    && !options.fanSpeedWarningSeen
  ) {
    return {
      kind: 'confirm',
      title: null,
      message: FAN_SPEED_DURING_PRINT_WARNING_MESSAGE,
      cancelLabel: 'Cancel',
      confirmLabel: 'Change Anyway',
      color: 'warning',
      rememberAs: 'fanSpeedDuringPrint'
    }
  }

  if (command.type === 'setChamberTemperature' && isPrintingTaskStage(status?.stage)) {
    if (status?.ductMode === 'cooling') {
      return {
        kind: 'notice',
        title: null,
        message: CHAMBER_TEMPERATURE_COOLING_MODE_WARNING_MESSAGE,
        acknowledgeLabel: 'OK'
      }
    }

    if (command.target >= 40 && status?.ductMode !== 'heating') {
      return {
        kind: 'confirm',
        title: null,
        message: CHAMBER_TEMPERATURE_HEATING_SWITCH_WARNING_MESSAGE,
        cancelLabel: 'Cancel',
        confirmLabel: 'OK',
        color: 'warning'
      }
    }
  }

  return null
}

function isPrintingTaskStage(stage: PrinterStage | null | undefined): boolean {
  return stage === 'preparing'
    || stage === 'heating'
    || stage === 'printing'
    || stage === 'paused'
}