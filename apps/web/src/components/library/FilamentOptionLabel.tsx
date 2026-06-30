/**
 * Shared filament label for the material pickers — the queue's `MaterialPickerDialog`, the queue row
 * dropdown, and the slice dialog's "Choose material" picker — laid out to match the print dialog's AMS
 * slot option ({@link SlotOptionLabel} in `PrinterMapping.tsx`): a colour circle (optionally carrying a
 * slot badge like `A1` via `swatchLabel`), a title line that folds
 * brand + type + colour into one string ("Bambu ABS · Jade White"), a meta line stacked *below* the
 * title carrying any caller detail (e.g. "File default") plus the remaining-quantity badge, and an
 * optional warning glyph on the right (e.g. for a type that differs from what the file was sliced
 * for) — the same trailing glyph the slot option shows for an incompatible slot.
 *
 * The remaining badge leads with the percent when known ("50% · 480g") to mirror the slot badge, and
 * when the print's required grams are known it grades sufficiency in three states — **enough**,
 * **low** (warning: enough but within a thin headroom), and **short** (danger: less than required) —
 * so the user sees not just "low or not" but whether the material actually has enough. Kept visually
 * in step with the slot picker so the print and add-to-queue dialogs read as the same control.
 */
import { Box, Stack, Tooltip, Typography } from '@mui/joy'
import type { ReactNode } from 'react'
import { filamentBackground, filamentTextColor, resolveProjectFilamentColorName } from '../../lib/filamentColor'
import { filamentRemainingStatus } from '../../lib/filamentSufficiency'
import { normalizeHexColor } from '@printstream/shared'

export function FilamentOptionLabel({
  color,
  colors,
  colorName,
  filamentType,
  filamentName,
  secondary,
  remainingGrams,
  remainPercent,
  requiredGrams,
  aggregated = false,
  warningLabel,
  swatchLabel,
  swatchSize = 32
}: {
  color?: string | null
  /** Multi-colour palette (gradient swatch); falls back to `color`. */
  colors?: readonly string[] | null
  /** Pre-resolved colour name (e.g. a loaded spool's reported name); falls back to deriving from `color`. */
  colorName?: string | null
  filamentType?: string | null
  /** Brand / preset name, folded into the title line ahead of the type. */
  filamentName?: string | null
  /** Extra detail shown on the meta line before the remaining badge (e.g. "File default"). */
  secondary?: ReactNode
  /** Remaining inventory for this material; rendered as the meta-line badge when known. */
  remainingGrams?: number | null
  /** Remaining as a percent of net weight; leads the badge ("50% · 480g") when known. */
  remainPercent?: number | null
  /** Grams this print needs — when both are known, an insufficient remaining badge warns/turns danger. */
  requiredGrams?: number | null
  /** True when the remaining grams sum across multiple spools — adds a "total" suffix to the badge. */
  aggregated?: boolean
  /** When set, a trailing warning glyph with this tooltip (e.g. a type mismatch vs the sliced file). */
  warningLabel?: string | null
  /** Short slot badge to centre inside the swatch (e.g. `A1`, `B2`) when the option is tied to a tray. */
  swatchLabel?: string | null
  swatchSize?: number
}) {
  const resolvedColorName = colorName ?? resolveProjectFilamentColorName({ color, filamentName, filamentType }) ?? normalizeHexColor(color)
  // One identity line, like the slot option's "Bambu ABS · Jade White": brand + type, then colour.
  // The type is only appended when the brand/preset name doesn't already carry it, so a sliced
  // default whose name is "Bambu ABS" doesn't read "Bambu ABS ABS".
  const brand = (filamentName ?? '').trim()
  const type = (filamentType ?? '').trim()
  const brandType = brand
    ? (brandIncludesType(brand, type) ? brand : [brand, type].filter(Boolean).join(' '))
    : type
  const title = [brandType || null, resolvedColorName].filter(Boolean).join(' · ') || 'Material'
  const status = filamentRemainingStatus(remainingGrams, requiredGrams, remainPercent, aggregated)
  // Whether a second (meta) line renders. The warning glyph only spans two grid rows when it does —
  // otherwise it forces a phantom second row that pushes the single title line above centre.
  const hasMeta = Boolean(secondary || status)
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, width: '100%' }}>
      <Box
        sx={{
          width: swatchSize,
          height: swatchSize,
          borderRadius: '50%',
          flexShrink: 0,
          background: filamentBackground(colors, color),
          color: filamentTextColor(colors, color, 'var(--joy-palette-text-primary)'),
          border: '1px solid var(--joy-palette-neutral-700)',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 'lg',
          lineHeight: 1
        }}
      >
        {swatchLabel || null}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 1, rowGap: 0.125 }}>
        <Typography level="body-xs" noWrap sx={{ minWidth: 0, gridColumn: '1 / 2' }}>{title}</Typography>
        {warningLabel ? (
          <Tooltip title={warningLabel} variant="soft" size="sm">
            <Box
              component="span"
              aria-label={warningLabel}
              sx={{ display: 'inline-flex', alignItems: 'center', color: 'warning.plainColor', flexShrink: 0, gridColumn: '2 / 3', gridRow: hasMeta ? '1 / span 2' : '1 / 2', alignSelf: 'center', justifySelf: 'end', cursor: 'help' }}
            >
              <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: 16, height: 16, display: 'block', fill: 'currentColor' }}>
                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
              </Box>
            </Box>
          </Tooltip>
        ) : null}
        {secondary || status ? (
          <Box sx={{ gridColumn: '1 / 2', display: 'flex', gap: 0.75, minWidth: 0, alignItems: 'baseline' }}>
            {secondary ? (
              <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>{secondary}</Typography>
            ) : null}
            {status ? (
              <Typography
                level="body-xs"
                noWrap
                textColor={status.tone}
                sx={{ flexShrink: 0, fontWeight: status.tone === 'text.tertiary' ? undefined : 'md' }}
              >
                {status.text}
              </Typography>
            ) : null}
          </Box>
        ) : null}
      </Box>
    </Stack>
  )
}

/** True when `type` already appears as a whole token in the brand/preset name (e.g. "Bambu ABS"). */
function brandIncludesType(brand: string, type: string): boolean {
  if (!type) return false
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(brand)
}
