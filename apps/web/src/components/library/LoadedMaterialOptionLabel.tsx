/**
 * One loaded printer material (AMS slot / external spool) rendered as a picker row.
 *
 * Owns the mapping from a `SliceMaterialOption` plus its LIVE tray to the shared
 * {@link FilamentOptionLabel}: the remaining-quantity fallback chain and the brand/label fold.
 * Every surface that offers "the materials loaded in the selected printer" renders through it
 * (today the material row's swatch menu, `MaterialSwatchButton`), so a new one inherits the
 * same row instead of re-deriving the label and drifting as the option shape grows.
 */
import { FilamentOptionLabel } from './FilamentOptionLabel'
import { resolveFilamentDisplay } from '../../lib/filamentColor'
import { estimateRemainGrams } from '../../lib/slotRemaining'
import type { PrinterTrayOption } from '../../lib/libraryViewHelpers'
import type { SliceMaterialOption } from '../../lib/sliceProfileMatching'

export function LoadedMaterialOptionLabel({ option, tray }: {
  option: SliceMaterialOption
  /** Live tray behind the option (`printerTrayMap.get(option.trayId)`); absent once it is unloaded. */
  tray: PrinterTrayOption | undefined
}) {
  // Remaining: the tracked spool's figure first (covers non-RFID custom filament);
  // otherwise only RFID/Bambu spools report a reliable estimate.
  const remainingGrams = option.remainingGrams
    ?? (tray && tray.trayUuid != null ? estimateRemainGrams(tray.remainPercent) : null)
  const remainPercent = option.remainPercent ?? tray?.remainPercent
  // Pre-fold "brand + type" so the brand isn't doubled when the label already carries it,
  // then hand the whole identity to the shared label as the name (type left to the label).
  const filamentName = option.brand && !option.label.toLowerCase().includes(option.brand.toLowerCase())
    ? `${option.brand} ${option.label}`
    : option.label
  return (
    <FilamentOptionLabel
      color={option.color}
      colors={option.colors}
      colorName={option.colorName ?? (tray ? resolveFilamentDisplay(tray).name : null)}
      filamentName={filamentName}
      swatchLabel={option.slotLabel}
      remainingGrams={remainingGrams}
      remainPercent={remainPercent}
    />
  )
}
