import type { PrinterConnectionValidation } from '@printstream/shared'

export function buildPrinterConnectionValidationFeedback(validation: PrinterConnectionValidation | null): {
  color: 'warning' | 'danger'
  messages: string[]
} | null {
  if (!validation || validation.ok) {
    return null
  }

  const messages = validation.warnings.map((warning) => warning.message)
  return {
    color: validation.warnings.some((warning) => warning.code === 'localConnectionFailed') ? 'danger' : 'warning',
    messages: messages.length > 0 ? messages : ['PrintStream could not verify this printer connection.']
  }
}
