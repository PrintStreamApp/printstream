/**
 * Sticky section headers for the slice-settings column.
 *
 * Both surfaces that render it, the 3D editor's sidebar and the prepare-print dialog, are one
 * tall scrolling column of `title row + outlined body` sections, and a long section (the model
 * list above all) used to scroll its own title away, taking that section's Add button with it.
 *
 * This module owns the two rules neither surface can get right on its own:
 *
 * 1. A header must COVER the one already pinned above it, never push it off. That only holds
 *    while every header is a DIRECT CHILD of the scrolling column: `position: sticky` cannot
 *    escape its parent, so a section wrapped in its own `<Stack>` makes that wrapper the
 *    containing block and its bottom edge evicts the header, which visibly shoves the pinned
 *    header out of the way instead of sliding under it. z-index cannot fix that; the element is
 *    being MOVED, not painted under. Callers therefore render the header and its body as
 *    SIBLINGS (which is why `PlatePausesSection` and friends return fragments, not a wrapper).
 *
 * 2. The background must be the SCROLL CONTAINER's own colour, painted OPAQUE. Sticky headers need
 *    an opaque background or the content scrolling beneath reads through the text, but any colour
 *    that is not the scroller's paints a visible bar across every header while it is unpinned.
 *    The sections do not all scroll in the same container, the editor sidebar scrolls inside a
 *    `background.level1` Sheet, the prepare-print dialog inside the `background.surface`
 *    ModalDialog, so one shared token is provably wrong for one of them. Each scroll container
 *    names its own colour with {@link StickySectionScope}; the default suits a plain dialog
 *    surface, which is what an unpainted scroller inside a modal shows through to.
 *
 *    Naming the right token is not enough on its own, because on the glass themes those tokens are
 *    themselves translucent (`background.level1` is `rgba(19, 27, 42, 0.6)`, `background.surface`
 *    0.55) -- they are meant to be layered over the page. A header that simply repeats the token is
 *    therefore BOTH see-through and, sitting on a scroller already painting that same colour, a
 *    shade darker than its surroundings. As one header slid under another, both titles and both
 *    action buttons rendered on top of each other. So the token is stripped to full opacity with
 *    relative colour syntax. The flat themes, whose tokens are already opaque hex, are unaffected.
 *
 * Counterparts: `SliceSettingsPanel` (slicer/printer/plate/process/materials/objects),
 * `PlateGcodeSections` (filament changes/pauses), and `EditorView` (models on plate).
 */
import { createContext, useContext, type ReactNode } from 'react'
import { Stack, type StackProps } from '@mui/joy'
import { opaqueScrollerBackground } from './stickySectionBackground'

/**
 * Every header is at least this tall so covering is exact. Pinned headers all stack at the same
 * offset and the later one paints over the earlier, so a header SHORTER than the one it covers
 * would leave that one's bottom edge peeking out beneath it. Matching Joy's `size="sm"` button
 * height means a title-only header still covers one that carries an action, in any order.
 */
const STICKY_SECTION_HEADER_MIN_HEIGHT = '2rem'

/**
 * Above the section bodies scrolling underneath, which is the whole point, but that also puts an
 * opaque band over anything else absolutely positioned in the same corner. Joy's `ModalClose` sits
 * at z-index 1, so a host whose close button shares the header's row must lift it ABOVE this value
 * or the header both hides it and swallows its clicks (the editor's objects bottom-sheet does).
 */
export const STICKY_SECTION_HEADER_Z_INDEX = 2

const StickySectionBackgroundContext = createContext<string>('background.surface')

/**
 * Declares the background a scroll container actually PAINTS, so the headers inside it disappear
 * into it while unpinned. Wrap the container's content. An unpainted scroller (a bare `overflow:
 * auto` Box) shows the surface behind it, so name that surface rather than the Box.
 */
export function StickySectionScope({ background, children }: { background: string; children: ReactNode }) {
  return (
    <StickySectionBackgroundContext.Provider value={background}>{children}</StickySectionBackgroundContext.Provider>
  )
}

/**
 * One section's header row, pinned to the top of the enclosing scroll container for as long as
 * its section is on screen. Must be rendered as a direct child of the scrolling column, beside
 * (not wrapping) the section's body: see the module header.
 */
export function StickySectionHeader({ children, sx, ...props }: StackProps) {
  const background = useContext(StickySectionBackgroundContext)
  return (
    <Stack
      direction="row"
      alignItems="center"
      {...props}
      sx={[
        {
          position: 'sticky',
          top: 0,
          zIndex: STICKY_SECTION_HEADER_Z_INDEX,
          minWidth: 0,
          minHeight: STICKY_SECTION_HEADER_MIN_HEIGHT,
          ...opaqueScrollerBackground(background)
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : [])
      ]}
    >
      {children}
    </Stack>
  )
}
