/**
 * Shared row components of the editor's right-click context menus: the in-place
 * submenu "back" row and the material / part-type option lists. Both the object menu
 * ({@link EditorContextMenu}) and the part menu ({@link EditorPartContextMenu}) swap
 * their content to these lists instead of cascading a nested popup, which keeps the
 * anchored-Menu wiring (click-away, Escape) shared with the parent. The menus'
 * Popper wiring + listbox styling live in `contextMenuChrome.ts` (components only
 * here, for react-refresh).
 */
import { Box, ListDivider, ListItemDecorator, MenuItem } from '@mui/joy'
import type { SceneEditPartSubtype } from '@printstream/shared'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import InventoryRoundedIcon from '@mui/icons-material/InventoryRounded'
import type { FilamentOption } from './EditorView'
import { PART_SUBTYPE_OPTIONS } from './editorGeometry'
import { PRIMITIVE_LABELS, type PrimitiveKind } from './lib/primitives'

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

/**
 * Where a new part's geometry comes from, mirroring BambuStudio's per-volume-type submenu
 * (`append_submenu_add_generic`): "Load…" first, then the built-in primitives. Ours splits Load
 * into the library and the device, because a model here usually already lives in the library.
 */
export function AddPartSourceMenuItems({ onPickPrimitive, onPickFile, onPickLibrary }: {
  onPickPrimitive: (shape: PrimitiveKind) => void
  onPickFile: () => void
  onPickLibrary: () => void
}) {
  return (
    <>
      <MenuItem onClick={onPickLibrary}>
        <ListItemDecorator><InventoryRoundedIcon /></ListItemDecorator>
        Load from library…
      </MenuItem>
      <MenuItem onClick={onPickFile}>
        <ListItemDecorator><FolderOpenRoundedIcon /></ListItemDecorator>
        Load from file…
      </MenuItem>
      <ListDivider />
      {(Object.keys(PRIMITIVE_LABELS) as PrimitiveKind[]).map((shape) => (
        <MenuItem key={shape} onClick={() => onPickPrimitive(shape)}>
          <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
          {PRIMITIVE_LABELS[shape]}
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
