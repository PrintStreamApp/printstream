/**
 * The menu body shared by every "pick a material" trigger in `SliceSettingsPanel`: a manual-pick
 * item followed by the printer's loaded materials, grouped by AMS unit and rendered with the
 * remaining-quantity badge (`LoadedMaterialOptionLabel`).
 *
 * Owned as one component because the two triggers must offer the SAME choices in the same order:
 * the material row's swatch (assign a loaded material to an existing slot) and the Materials
 * header's Add button (create a slot from a loaded material). They diverged when the Add button
 * could only open the manual dialog, so a user with a loaded AMS had to name a preset by hand for a
 * material the printer was already holding.
 *
 * Renders menu items only; each caller supplies its own `Menu`, since the trigger and placement
 * differ. Counterpart data builder: `buildLoadedPrinterMaterialOptions` in `lib/slicingPresetMatching`.
 */
import { ListDivider, MenuItem, Typography } from '@mui/joy'
import { Fragment } from 'react'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { LoadedMaterialOptionLabel } from './LoadedMaterialOptionLabel'
import type { PrinterTrayOption } from '../../lib/libraryViewHelpers'
import type { SliceMaterialOption } from '../../lib/slicingPresetMatching'

/** The printer's loaded materials for one trigger, already prioritized and grouped. */
export interface LoadedMaterialMenuSource {
  groups: Array<{ label: string; options: SliceMaterialOption[] }>
  /** Live trays by mapping value, for the remaining-quantity badge on each row. */
  trayMap: Map<number, PrinterTrayOption>
  onSelect: (option: SliceMaterialOption) => void
}

export function LoadedMaterialMenuItems({ loaded, manualLabel, onChooseManually, selectedMaterialOptionId }: {
  loaded: LoadedMaterialMenuSource
  /** Wording for the manual item: the two triggers assign vs create, so they word it differently. */
  manualLabel: string
  onChooseManually: () => void
  /** Ticks the row already assigned to this slot; absent when creating a new one. */
  selectedMaterialOptionId?: string | null
}): JSX.Element {
  return (
    <>
      <MenuItem onClick={onChooseManually}>
        <TuneRoundedIcon fontSize="small" />
        {manualLabel}
      </MenuItem>
      {loaded.groups.map((group) => (
        <Fragment key={group.label}>
          <ListDivider />
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            sx={{ px: 1, pt: 0.5, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            {group.label}
          </Typography>
          {group.options.map((option) => (
            <MenuItem
              key={option.id}
              selected={selectedMaterialOptionId != null && option.id === selectedMaterialOptionId}
              onClick={() => loaded.onSelect(option)}
            >
              <LoadedMaterialOptionLabel
                option={option}
                tray={option.trayId != null ? loaded.trayMap.get(option.trayId) : undefined}
              />
            </MenuItem>
          ))}
        </Fragment>
      ))}
    </>
  )
}
