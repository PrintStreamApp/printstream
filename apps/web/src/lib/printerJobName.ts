/**
 * Printer job-name display helpers.
 *
 * Active 3MF prints surface the raw dispatch subtask name from the printer,
 * which uses fallback labels like `plate_4` when a plate has no custom name.
 * The UI keeps the raw value for API lookups, but presents a friendlier label.
 */
import { inferObservedPrintPlateIndex, normalizeFallbackPlateLabel } from '@printstream/shared'

interface FormatPrinterJobDisplayNameInput {
  jobName: string | null | undefined
  gcodeFile?: string | null | undefined
  plate?: number | null | undefined
}

export function formatPrinterJobDisplayName(input: FormatPrinterJobDisplayNameInput): string {
  const normalizedJobName = input.jobName?.trim()
  if (!normalizedJobName) return ''

  const splitIndex = normalizedJobName.lastIndexOf(' - ')
  if (splitIndex <= 0) return normalizedJobName

  const title = normalizedJobName.slice(0, splitIndex).trim()
  const rawPlateLabel = normalizedJobName.slice(splitIndex + 3).trim()
  if (!title || !rawPlateLabel) return normalizedJobName

  const inferredPlate = input.plate ?? inferObservedPrintPlateIndex({ gcodeFile: input.gcodeFile })
  const normalizedPlateLabel = normalizeFallbackPlateLabel(rawPlateLabel)
  if (normalizedPlateLabel === rawPlateLabel && inferredPlate == null) {
    return normalizedJobName
  }

  return `${title} - ${normalizedPlateLabel}`
}