/**
 * Printer validation for the bridge-only runtime.
 *
 * The API no longer opens direct local MQTT connections; reachability and
 * printer transport live exclusively inside the bridge runtime.
 */
import {
  bridgePrinterValidationParamsSchema,
  bridgePrinterValidationResultSchema,
  type PrinterConnectionValidation,
  type PrinterConnectionValidationInput
} from '@printstream/shared'
import { conflict } from './http-error.js'
import { bridgeSessionManager } from './bridge-session-manager.js'

export async function validatePrinterLanConnection(
  input: PrinterConnectionValidationInput,
  bridgeId: string
): Promise<PrinterConnectionValidation> {
  if (!bridgeSessionManager.isConnected(bridgeId)) {
    throw conflict('Selected bridge is not connected.')
  }

  const result = await bridgeSessionManager.requestRpc(
    bridgeId,
    'printer.validateConnection',
    bridgePrinterValidationParamsSchema.parse(input)
  )
  return bridgePrinterValidationResultSchema.parse(result)
}