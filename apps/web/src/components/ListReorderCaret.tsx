/**
 * The insertion caret for a drag-reorder list: the bar drawn in the gap a drop would land in.
 *
 * Counterpart to `hooks/useListReorderDrag.ts`, which supplies the `drag` this renders. Every
 * reorderable list in the app draws the same caret -- the editor's plate strip and object sidebar,
 * the slice panel's materials list, the nav-tab order editor -- and it was four copies of one
 * `sx` block before this existed, already drifting: the fourth shipped without the comment
 * explaining why the margins are zeroed, which is how the next person deletes that rule.
 *
 * Three things it owns that a caller keeps getting wrong. It is ALWAYS mounted and moved
 * imperatively by the hook, never rendered per position: the gap changes every time the pointer
 * crosses a row, and re-rendering the list that often is what made a drag down the editor's object
 * sidebar cost one render of its most expensive component per row. It positions in the scroll
 * container's CONTENT coordinates, so it scrolls with the tiles rather than floating over them,
 * which means the container must be `position: relative`. And it zeroes its own margins with
 * `!important`: it is rendered as the last child of a `Stack`/`List`, so without that the parent's
 * sibling spacing treats it as a real row and shifts every tile by a gap while the drag is live.
 */
import { Box } from '@mui/joy'

/** Caret thickness. Centred on the gap by a CSS transform, so the hook sets one coordinate. */
const CARET_THICKNESS_PX = 3
/** Inset from the container's edges, so the caret reads as belonging to the list. */
const CARET_INSET_PX = 4

export function ListReorderCaret({ setCaretElement, vertical = true }: {
  /** `setCaretElement` from `useListReorderDrag`, which shows, hides and positions this. */
  setCaretElement: (element: HTMLElement | null) => void
  /** Which way the list runs. A vertical list gets a horizontal bar, and vice versa. */
  vertical?: boolean
}) {
  return (
    <Box
      ref={setCaretElement}
      aria-hidden
      sx={{
        position: 'absolute',
        // Hidden until a drag positions it; the hook owns `display` from here on.
        display: 'none',
        m: '0 !important',
        pointerEvents: 'none',
        zIndex: 1,
        borderRadius: '2px',
        bgcolor: 'primary.400',
        // Centred by transform rather than by subtracting half the thickness: the hook then writes
        // ONE coordinate per frame and never has to measure this element, which would force a
        // layout flush on every pointer move.
        ...(vertical
          ? { left: CARET_INSET_PX, right: CARET_INSET_PX, height: CARET_THICKNESS_PX, transform: 'translateY(-50%)' }
          : { top: CARET_INSET_PX, bottom: CARET_INSET_PX, width: CARET_THICKNESS_PX, transform: 'translateX(-50%)' })
      }}
    />
  )
}
