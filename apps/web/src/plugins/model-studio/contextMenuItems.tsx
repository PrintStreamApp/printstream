/**
 * Shared pieces of the editor's right-click context menus: the cursor-anchored Popper
 * wiring + listbox styling, the in-place submenu "back" row, and the material /
 * part-type option lists. Both the object menu ({@link EditorContextMenu}) and the part
 * menu ({@link EditorPartContextMenu}) swap their content to these lists instead of
 * cascading a nested popup, which keeps the anchored-Menu wiring (click-away, Escape)
 * shared with the parent.
 */
import { Box, ListItemDecorator, MenuItem } from '@mui/joy'
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import type { SxProps } from '@mui/joy/styles/types'
import type { SceneEditPartSubtype } from '@printstream/shared'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import type { FilamentOption } from './EditorView'
import { PART_SUBTYPE_OPTIONS } from './editorGeometry'

/**
 * Popper wiring for a cursor-anchored context menu (zero-size virtual anchor at the
 * right-click point). `flip` moves the menu to the other side of the cursor when that
 * side fits; when NEITHER side fits, `preventOverflow` must shift it back inside the
 * viewport — and Popper's default only constrains the main axis, which for a vertical
 * placement is the horizontal one, so tall menus used to run off the bottom edge.
 * `altAxis: true` adds the vertical constraint and `tether: false` lets the shift move
 * the menu past (over) the anchor point instead of stopping beside it.
 */
export const CONTEXT_MENU_POPPER_MODIFIERS = [
  { name: 'flip', options: { padding: 8 } },
  { name: 'preventOverflow', options: { padding: 8, altAxis: true, tether: false } }
]

/** Shared context-menu listbox styling; pairs with {@link CONTEXT_MENU_POPPER_MODIFIERS}. */
export const CONTEXT_MENU_SX: SxProps = {
  zIndex: (theme) => theme.zIndex.tooltip,
  // A menu taller than the whole viewport (the full single-object menu with
  // move-to-plate rows) scrolls rather than running items off both edges.
  maxHeight: 'calc(100dvh - 16px)',
  overflowY: 'auto',
  // In a vertical menu Joy's ListItemDecorator only reserves height, not width, so
  // icons of differing glyph widths leave the labels ragged. Pin a fixed icon column
  // and a uniform icon size so every label starts at the same x.
  [`& .${listItemDecoratorClasses.root}`]: { minInlineSize: '1.75rem' },
  '& svg': { fontSize: '1.25rem' }
}

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
