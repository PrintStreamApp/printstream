/**
 * The material row's swatch trigger in `SliceSettingsPanel`: the material's number, preset and
 * colour name painted on the material's own colour.
 *
 * What a click does depends on whether the printer's loaded materials are available:
 *  - none (a manual profile target, or a printer with nothing loaded for this slot): opens
 *    `MaterialEditDialog` directly, as the row always did.
 *  - available: opens a menu whose first item opens that dialog for a manual pick, followed by
 *    the loaded materials themselves, grouped and rendered like every other loaded-filament
 *    surface (`LoadedMaterialOptionLabel`). Assigning what is already in the printer — the
 *    common case once a printer is selected — is then two clicks, which is why this menu
 *    replaced the dialog's old "Choose from printer" shortcut and its stacked picker Modal.
 *
 * The menu assigns through the caller's controller, so the 3D editor's dirty flag and undo see
 * the edit without the `materialEditListenerRef` detour the removed Modal needed.
 */
import { Box, Dropdown, ListDivider, Menu, MenuButton, MenuItem, Typography } from '@mui/joy'
import type { SxProps } from '@mui/joy/styles/types'
import { Fragment } from 'react'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { LoadedMaterialOptionLabel } from './LoadedMaterialOptionLabel'
import { filamentTextColor } from '../../lib/filamentColor'
import type { PrinterTrayOption } from '../../lib/libraryViewHelpers'
import type { SliceMaterialOption } from '../../lib/sliceProfileMatching'

/** The printer's loaded materials for ONE material slot, already prioritized and grouped. */
export interface SwatchLoadedMaterials {
  groups: Array<{ label: string; options: SliceMaterialOption[] }>
  /** Live trays by mapping value, for the remaining-quantity badge on each row. */
  trayMap: Map<number, PrinterTrayOption>
  onSelect: (option: SliceMaterialOption) => void
}

export function MaterialSwatchButton({
  filamentIndex,
  presetName,
  colorName,
  color,
  presetUnmatched,
  selectedMaterialOptionId,
  loadedMaterials,
  onOpenMaterialDialog
}: {
  filamentIndex: number
  /** Preset (or project filament) name shown on the row. */
  presetName: string
  colorName: string
  /** Normalized hex the row is painted with. */
  color: string
  /** No slicing preset matched this filament — the row warns and the tooltip says to pick one. */
  presetUnmatched: boolean
  /** Currently-assigned material option, so the menu can mark it. */
  selectedMaterialOptionId: string | null
  /** Null (or empty) when no printer material is on offer — the click then opens the dialog. */
  loadedMaterials: SwatchLoadedMaterials | null
  onOpenMaterialDialog: () => void
}) {
  const menuMaterials = loadedMaterials && loadedMaterials.groups.length > 0 ? loadedMaterials : null
  const title = presetUnmatched
    ? 'No preset matches this filament — click to pick one'
    : `${presetName} · ${colorName} — ${menuMaterials ? 'change material' : 'edit material'}`
  const label = `${menuMaterials ? 'Change' : 'Edit'} material ${filamentIndex + 1}: ${presetName}, ${colorName}`
  const rowSx: SxProps = {
    appearance: 'none',
    flex: '1 1 140px',
    minWidth: 0,
    // Explicit height, and no Joy Button min-height under it, so the row keeps the height of the
    // inputs beside it in both renderings (plain button and MenuButton).
    height: 'var(--Input-minHeight, 2.25rem)',
    minHeight: 0,
    px: 1,
    py: 0,
    borderRadius: 'sm',
    border: (theme) => `1px solid ${theme.vars.palette.divider}`,
    background: color,
    color: filamentTextColor(null, color),
    // The warning glyph must read against the FILAMENT colour, not Joy's plain-variant icon colour.
    '--Icon-color': 'currentColor',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 0.75,
    overflow: 'hidden',
    // Border-only hover feedback, deliberately no scale: the row anchors the menu, so growing it
    // on hover shifted the open menu as the pointer travelled from the swatch into it.
    transition: 'border-color 80ms ease',
    // Repeats `background` because Joy's Button (the MenuButton root) paints its own hover fill.
    '&:hover': { background: color, borderColor: 'primary.outlinedBorder' },
    '&:focus-visible': {
      outline: (theme) => `2px solid ${theme.vars.palette.focusVisible}`,
      outlineOffset: 2
    }
  }
  const content = (
    <>
      <Typography level="body-xs" sx={{ fontWeight: 700, lineHeight: 1, color: 'inherit', flexShrink: 0 }}>
        {filamentIndex + 1}
      </Typography>
      <Typography level="body-xs" fontWeight="md" noWrap sx={{ color: 'inherit' }}>
        {presetName} · {colorName}
      </Typography>
      {/* Positioned by a Joy wrapper: `sx` on a Material icon runs through the Material style
          engine, which this Joy-only app gives no theme, and throws at render. */}
      {presetUnmatched && (
        <Box sx={{ ml: 'auto', flexShrink: 0, display: 'inline-flex' }}>
          <WarningAmberRoundedIcon fontSize="small" />
        </Box>
      )}
    </>
  )
  if (!menuMaterials) {
    return (
      <Box component="button" type="button" onClick={onOpenMaterialDialog} title={title} aria-label={label} sx={rowSx}>
        {content}
      </Box>
    )
  }
  return (
    <Dropdown>
      <MenuButton variant="plain" color="neutral" title={title} aria-label={label} sx={rowSx}>
        {content}
      </MenuButton>
      <Menu
        placement="bottom-start"
        // The row renders inside a Modal (the slice dialog) or above the 3D editor; Joy's tooltip
        // layer is the only built-in one that beats `modal`.
        sx={{ zIndex: (theme) => theme.zIndex.tooltip, minWidth: 280, maxWidth: 'calc(100vw - 32px)', maxHeight: '60vh', overflowY: 'auto' }}
      >
        <MenuItem onClick={onOpenMaterialDialog}>
          <TuneRoundedIcon fontSize="small" />
          Choose manually…
        </MenuItem>
        {loadedMaterials!.groups.map((group) => (
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
                selected={option.id === selectedMaterialOptionId}
                onClick={() => loadedMaterials!.onSelect(option)}
              >
                <LoadedMaterialOptionLabel
                  option={option}
                  tray={option.trayId != null ? loadedMaterials!.trayMap.get(option.trayId) : undefined}
                />
              </MenuItem>
            ))}
          </Fragment>
        ))}
      </Menu>
    </Dropdown>
  )
}
