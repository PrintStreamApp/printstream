/**
 * Shared chrome (Popper wiring + listbox styling) for the editor's cursor-anchored
 * right-click context menus. Split from `contextMenuItems.tsx` so that file exports
 * only components (react-refresh); both the object menu (`EditorContextMenu`) and the
 * part menu (`EditorPartContextMenu`) consume these.
 */
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import type { SxProps } from '@mui/joy/styles/types'
import { EDITOR_POPUP_Z_INDEX } from './editorLayers'

/**
 * Popper wiring for a cursor-anchored context menu (zero-size virtual anchor at the
 * right-click point). `flip` moves the menu to the other side of the cursor when that
 * side fits; when NEITHER side fits, `preventOverflow` must shift it back inside the
 * viewport, and Popper's default only constrains the main axis, which for a vertical
 * placement is the horizontal one, so tall menus used to run off the bottom edge.
 * `altAxis: true` adds the vertical constraint and `tether: false` lets the shift move
 * the menu past (over) the anchor point instead of stopping beside it.
 */
/**
 * Where a context menu is anchored, and which corner it hangs from.
 *
 * A right-click anchors at the CURSOR and hangs `start` (top-left at the point), which is what a
 * pointer expects. A row's kebab anchors at the BUTTON and hangs `end`, so the menu's right edge
 * lines up with the button's: these rows sit at the right of the sidebar, and a `start` menu there
 * overflows and gets shoved left by `preventOverflow` until its right edge meets the button's LEFT
 * edge -- it reads as opening diagonally away from the icon that spawned it.
 */
export interface ContextMenuAnchor {
  x: number
  y: number
  align?: 'start' | 'end'
}

export const CONTEXT_MENU_POPPER_MODIFIERS = [
  { name: 'flip', options: { padding: 8 } },
  { name: 'preventOverflow', options: { padding: 8, altAxis: true, tether: false } }
]

/**
 * Whether an event came from within the open context menu.
 *
 * Used to tell an outside interaction (which dismisses the menu) from the menu's OWN. That
 * distinction is easy to forget for scrolling, because the menu is capped at the viewport height
 * and scrolls itself (see `maxHeight`/`overflowY` below): a dismiss-on-scroll guard that ignores
 * where the event came from closes the menu the instant someone wheels toward the item they opened
 * it for. `contains` reports true for the node itself, which is what covers scrolling, since the
 * listbox IS the scrolling element rather than an ancestor of it.
 */
export function isInsideContextMenu(listbox: Node | null | undefined, target: EventTarget | null): boolean {
  return listbox != null && target instanceof Node && listbox.contains(target)
}

/** Shared context-menu listbox styling; pairs with {@link CONTEXT_MENU_POPPER_MODIFIERS}. */
export const CONTEXT_MENU_SX: SxProps = {
  zIndex: EDITOR_POPUP_Z_INDEX,
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
