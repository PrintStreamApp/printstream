/**
 * Shared chrome (Popper wiring + listbox styling) for the editor's cursor-anchored
 * right-click context menus. Split from `contextMenuItems.tsx` so that file exports
 * only components (react-refresh); both the object menu (`EditorContextMenu`) and the
 * part menu (`EditorPartContextMenu`) consume these.
 */
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import type { SxProps } from '@mui/joy/styles/types'

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
