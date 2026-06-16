import type { PrinterCommand, PrinterStatus } from '@printstream/shared'

export const CHAMBER_LIGHT_OFF_CONFIRMATION_MESSAGE = 'Turning off the lights during the task will cause the failure of AI monitoring, like spaghetti detection. Please choose carefully.'

export function shouldConfirmChamberLightTurnOff(
  status: Pick<PrinterStatus, 'chamberLightOffRequiresConfirm'> | null | undefined,
  command: PrinterCommand
): command is Extract<PrinterCommand, { type: 'light'; node: 'chamber'; on: false }> {
  return command.type === 'light'
    && command.node === 'chamber'
    && command.on === false
    && Boolean(status?.chamberLightOffRequiresConfirm)
}