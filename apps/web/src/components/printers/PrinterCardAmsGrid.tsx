/**
 * The printer-card AMS section: a responsive grid of {@link AmsUnitRow}s (one per AMS unit, each
 * spanning a column count proportional to its slots) followed by any external spools. Slot/unit
 * actions are passed in already gated by permission — an absent handler hides that action.
 * Extracted from PrinterCard to keep the card body render-focused.
 */
import { Box } from '@mui/joy'
import type { AmsSlot, AmsUnit, ExternalSpool } from '@printstream/shared'
import { AmsUnitRow, ExternalSpoolRow } from './PrinterCardRows'
import { amsUnitSlotSpan } from '../../lib/printersViewHelpers'

export interface PrinterCardAmsGridProps {
  amsUnits: AmsUnit[]
  amsGridColumns: number
  externalSpools: ExternalSpool[]
  showExternalSpools: boolean
  cardsPerRow: number
  submitting: boolean
  /** Printer identity, forwarded to per-slot plugin slots (e.g. filament calibration). */
  printerId: string
  printerModel: string
  onRefresh?: () => void
  onOpenDrying?: (unitId: number) => void
  onEditSlot?: (unit: AmsUnit, slot: AmsSlot) => void
  onRescanSlot?: (unit: AmsUnit, slot: AmsSlot) => void
  /** Resolves why a slot's rescan is currently unavailable (tooltip + disabled), or null when allowed. */
  rescanSlotDisabledReason?: (unit: AmsUnit, slot: AmsSlot) => string | null
  onResetSlot?: (unit: AmsUnit, slot: AmsSlot) => void
  onEditExternalSpool?: (spool: ExternalSpool) => void
}

export function PrinterCardAmsGrid({
  amsUnits,
  amsGridColumns,
  externalSpools,
  showExternalSpools,
  cardsPerRow,
  submitting,
  printerId,
  printerModel,
  onRefresh,
  onOpenDrying,
  onEditSlot,
  onRescanSlot,
  rescanSlotDisabledReason,
  onResetSlot,
  onEditExternalSpool
}: PrinterCardAmsGridProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gap: { xs: 0.5, sm: 0.75 },
        gridTemplateColumns: {
          xs: 'repeat(4, minmax(0, 1fr))',
          sm: `repeat(${amsGridColumns}, minmax(0, 1fr))`
        },
        '& > *': { minWidth: 0 }
      }}
    >
      {amsUnits.map((unit) => (
        <Box
          key={unit.unitId}
          sx={{
            gridColumn: {
              xs: `span ${amsUnitSlotSpan(unit)}`,
              sm: `span ${amsUnitSlotSpan(unit)}`
            }
          }}
        >
          <AmsUnitRow
            unit={unit}
            compact={amsUnitSlotSpan(unit) < 4}
            printerId={printerId}
            printerModel={printerModel}
            onRefresh={onRefresh}
            onOpenDrying={onOpenDrying ? () => onOpenDrying(unit.unitId) : undefined}
            onEditSlot={onEditSlot ? (slot) => onEditSlot(unit, slot) : undefined}
            onRescanSlot={onRescanSlot ? (slot) => onRescanSlot(unit, slot) : undefined}
            rescanSlotDisabledReason={rescanSlotDisabledReason ? (slot) => rescanSlotDisabledReason(unit, slot) : undefined}
            onResetSlot={onResetSlot ? (slot) => onResetSlot(unit, slot) : undefined}
            slotActionsDisabled={submitting}
          />
        </Box>
      ))}
      {showExternalSpools && externalSpools.map((spool) => (
        <Box
          key={spool.amsId}
          sx={{
            gridColumn: {
              xs: 'span 1',
              sm: 'span 1'
            }
          }}
        >
          <ExternalSpoolRow
            spool={spool}
            spoolCount={externalSpools.length}
            compact={cardsPerRow >= 4}
            onEdit={onEditExternalSpool ? () => onEditExternalSpool(spool) : undefined}
            printerId={printerId}
          />
        </Box>
      ))}
    </Box>
  )
}
