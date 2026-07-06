/**
 * Shared leaf items for the editor's right-click context menus: the in-place submenu
 * "back" row and the material / part-type option lists. Both the object menu
 * ({@link EditorContextMenu}) and the part menu ({@link EditorPartContextMenu}) swap
 * their content to these lists instead of cascading a nested popup, which keeps the
 * anchored-Menu wiring (click-away, Escape) shared with the parent.
 */
import { Box, ListItemDecorator, MenuItem } from '@mui/joy'
import type { SceneEditPartSubtype } from '@printstream/shared'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import type { FilamentOption } from './EditorView'
import { PART_SUBTYPE_OPTIONS } from './editorGeometry'

/** First row of an in-place submenu: returns to the menu's root item list. */
export function ContextMenuBackItem({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <MenuItem
      onClick={(event) => {
        // Swap back to the root list without letting the click bubble into
        // anything that would close the menu.
        event.stopPropagation()
        onBack()
      }}
    >
      <ListItemDecorator><ArrowBackRoundedIcon /></ListItemDecorator>
      {label}
    </MenuItem>
  )
}

/** One menu row per project material, matching the filament-badge picker rows. */
export function FilamentMenuItems({ options, onPick }: {
  options: ReadonlyArray<FilamentOption>
  onPick: (filamentId: number) => void
}) {
  return (
    <>
      {options.map((option) => (
        <MenuItem key={option.id} onClick={() => onPick(option.id)} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ flexShrink: 0, width: 16, height: 16, borderRadius: '3px', bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
          <span>Material {option.id}{option.label ? ` — ${option.label}` : ''}{option.colorName ? ` (${option.colorName})` : ''}</span>
        </MenuItem>
      ))}
    </>
  )
}

/** One menu row per Bambu part subtype (BambuStudio's "Change type" options). */
export function PartTypeMenuItems({ onPick }: { onPick: (subtype: SceneEditPartSubtype) => void }) {
  return (
    <>
      {PART_SUBTYPE_OPTIONS.map((option) => (
        <MenuItem key={option.subtype} onClick={() => onPick(option.subtype)}>
          {option.label}
        </MenuItem>
      ))}
    </>
  )
}
