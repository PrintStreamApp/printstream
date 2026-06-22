/**
 * The printer-card attention line: a one-line, colour-coded summary of why a printer needs
 * attention (HMS warning vs. a more serious error), with an optional inline "clear error" button.
 * Extracted from PrinterCard to keep the card body render-focused.
 */
import { type RefObject } from 'react'
import { IconButton, Stack } from '@mui/joy'
import { OverflowTooltipText } from '../OverflowTooltipText'

export interface PrinterCardAttentionSummaryProps {
  text: string
  /** HMS warnings render warning-toned; everything else renders danger-toned. */
  isHmsError: boolean
  observeRef: RefObject<HTMLElement | null>
  clearing: boolean
  onClear?: () => void
}

export function PrinterCardAttentionSummary({
  text,
  isHmsError,
  observeRef,
  clearing,
  onClear
}: PrinterCardAttentionSummaryProps) {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
      <OverflowTooltipText
        level="body-xs"
        noWrap
        sx={{
          minWidth: 0,
          flex: 1,
          color: isHmsError
            ? 'var(--joy-palette-warning-300)'
            : 'var(--joy-palette-danger-300)'
        }}
        text={text}
        observeRef={observeRef}
      />
      {onClear && (
        <IconButton
          size="sm"
          variant="plain"
          color="danger"
          aria-label="Clear printer error"
          disabled={clearing}
          onClick={onClear}
          sx={{ minHeight: 0, minWidth: 0, p: 0.25, flexShrink: 0 }}
        >
          ✕
        </IconButton>
      )}
    </Stack>
  )
}
