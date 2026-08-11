/**
 * The hardware-identity chips for a machine: the soft-neutral model chip, the soft-primary
 * nozzle-size chip, and the soft-neutral installed-plate chip. Extracted from the printer card's
 * header (PrinterCardHardwareChips) so the printer picker rows render a machine exactly as its
 * card does — same chips, same colours, same label text. Callers own placement and any
 * surface-specific tooltip on the model chip (the card wraps it in IP/Wi-Fi facts); the nozzle
 * and plate chips explain themselves via fixed tooltips.
 */
import { Chip, Tooltip } from '@mui/joy'
import type { ReactNode } from 'react'
import { formatPrinterModelLabel } from '../../lib/slicingPresetMatching'

export function PrinterHardwareChips({
  model,
  modelTooltip,
  nozzleSizeLabel,
  plateTypeLabel
}: {
  /** Raw printer model; formatted here so every surface shows identical text. Null hides the chip
   * (e.g. picker rows already sitting under a model group heading). */
  model?: string | null
  modelTooltip?: ReactNode
  /** Pre-formatted via `formatPrinterNozzleSizesLabel`; null hides the chip. */
  nozzleSizeLabel: string | null
  /** The manually-set installed build plate (pre-formatted); null or omitted hides the chip. */
  plateTypeLabel?: string | null
}) {
  const modelChip = model
    ? <Chip size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>{formatPrinterModelLabel(model)}</Chip>
    : null
  return (
    <>
      {modelChip && (modelTooltip
        ? <Tooltip arrow placement="top" title={modelTooltip}>{modelChip}</Tooltip>
        : modelChip)}
      {nozzleSizeLabel && (
        <Tooltip arrow placement="top" title="Current nozzle size">
          <Chip size="sm" variant="soft" color="primary" sx={{ flexShrink: 0 }}>{nozzleSizeLabel}</Chip>
        </Tooltip>
      )}
      {plateTypeLabel && (
        <Tooltip arrow placement="top" title="Current build plate">
          <Chip size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>{plateTypeLabel}</Chip>
        </Tooltip>
      )}
    </>
  )
}
