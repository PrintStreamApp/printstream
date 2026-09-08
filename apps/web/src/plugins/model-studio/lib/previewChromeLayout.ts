/**
 * Where the 3D preview's floating controls sit, as a function of which chrome is showing.
 *
 * Four controls share two corners of one viewport, and which of them are present changes with
 * the preview mode and the full-screen toggle. That is a pile of interacting inline ternaries
 * whose wrong cases are invisible: nothing throws when two absolutely-positioned boxes land on
 * each other, the higher z-index simply paints over the other and takes its clicks. It has
 * happened twice, so the rules live here where they can be asserted.
 *
 * The ordering rule: the two G-code scrubbers OWN the viewport's edges (the moves strip the top,
 * the layer column the right) and everything else yields to them, rather than the scrubbers
 * shrinking to leave a corner free. A scrubber that gives up travel is worse on a phone than a
 * button that moves.
 *
 * The one control this module does not place is the dialog's own close button, which belongs to
 * the dialog rather than the viewport. It still has to be accounted for: in full screen the
 * dialog drops its padding and header, so the viewport IS the dialog and that button lands
 * inside it. {@link clearsDialogClose} is the check.
 *
 * Counterpart: `PreviewView.tsx`, which spreads these onto the controls.
 */

/** Inset every floating viewport control keeps from the edge it hugs. */
export const VIEWPORT_INSET_PX = 12

/**
 * One floating viewport control plus its inset: what a neighbour must skip to clear it.
 *
 * Measured against the rendered controls at 390px (moves strip 55 tall, layer column 79 wide,
 * each inset 12), plus a gap. Not guessed from their padding, which is what left them
 * overlapping by a few pixels.
 */
export const VIEWPORT_CONTROL_RESERVE_PX = 64

/** Width the moves scrubber leaves along its right for the layer column. */
export const VIEWPORT_LAYER_COLUMN_RESERVE = { xs: 100, sm: 104 }

/** A floating icon control's own size: Joy's `md` IconButton. */
export const VIEWPORT_CONTROL_SIZE_PX = 32

/**
 * How far the dialog's close button reaches into the viewport's top-right corner.
 *
 * Its own inset plus the button. Only meaningful in full screen, where that button sits on the
 * viewport rather than in the dialog's header.
 */
export const DIALOG_CLOSE_FOOTPRINT_PX = VIEWPORT_INSET_PX + VIEWPORT_CONTROL_SIZE_PX

/** What a viewport control must skip to clear the close button, with a gap. */
export const DIALOG_CLOSE_CLEARANCE_PX = DIALOG_CLOSE_FOOTPRINT_PX + 8

/**
 * How far the view cube reaches into the viewport's bottom-left corner.
 *
 * `VIEW_CUBE_EDGE_INSET` (8) + `VIEW_CUBE_SIZE` (92) from `lib/viewCube.ts`, restated here rather
 * than imported because that module pulls in THREE and this one is pure (and unit-tested without
 * a renderer). `previewChromeLayout.test.ts` pins the number so the two cannot drift silently.
 *
 * Note this is much larger than {@link VIEWPORT_CONTROL_RESERVE_PX}, which was measured against
 * the scrubbers: reusing that for the cube put the conflict banner 24px INSIDE it, under a control
 * whose z-index is `tooltip`, so the cube covered the banner's warning icon and took its clicks.
 */
export const VIEW_CUBE_FOOTPRINT_PX = 100

/** A pixel inset, or one per breakpoint where the control's size changes with the viewport. */
export type ResponsiveInset = number | { xs: number; sm: number }

export interface PreviewChromeInput {
  /** Full screen drops the dialog's padding and header, putting its close button on the viewport. */
  fullScreen: boolean
  showsGcodeLayerColumn: boolean
  showsGcodeMovesStrip: boolean
}

export interface PreviewChromeLayout {
  /** Enlarges the 3D area alone, so it sits on the 3D area rather than in the dialog header. */
  fullScreenToggle: { top: number; right: ResponsiveInset }
  /** Slim bar along the top while the plate's parts stream in. */
  sceneProgress: { top: number; left: number; right: number }
  /** The layer scrubber's column, running the viewport's full right edge. */
  gcodeLayerColumn: { top: number; right: number; bottom: number }
  /** The move scrubber's strip, running the top edge up to the layer column. */
  gcodeMovesStrip: { top: number; left: number; right: ResponsiveInset }
  /**
   * The toolpath-conflict warning, sitting ABOVE the view cube along the bottom edge.
   *
   * Above rather than beside: the cube is 92px square, so clearing it horizontally would leave the
   * banner about 180px wide on a phone, and a wrapped four-line warning is then taller than what
   * it saved. Stacking keeps the full width and makes the horizontal collision impossible.
   */
  gcodeConflictAlert: { bottom: number; left: number; right: ResponsiveInset }
}

/** The narrowest value a responsive inset takes, i.e. its worst case for clearance. */
export function smallestInset(inset: ResponsiveInset): number {
  return typeof inset === 'number' ? inset : Math.min(inset.xs, inset.sm)
}

/**
 * Whether a control in the top-right corner misses the dialog's close button.
 *
 * True when it starts below the button OR left of it; touching on one axis alone is not a
 * collision. Callers pass the worst case of a responsive inset.
 */
export function clearsDialogClose(control: { top: number; right: ResponsiveInset }): boolean {
  return control.top >= DIALOG_CLOSE_FOOTPRINT_PX || smallestInset(control.right) >= DIALOG_CLOSE_FOOTPRINT_PX
}

export function previewChromeLayout({
  fullScreen,
  showsGcodeLayerColumn,
  showsGcodeMovesStrip
}: PreviewChromeInput): PreviewChromeLayout {
  return {
    fullScreenToggle: {
      // Steps clear of each scrubber that is present, into the inner corner between them.
      top: showsGcodeMovesStrip ? VIEWPORT_INSET_PX + VIEWPORT_CONTROL_RESERVE_PX : VIEWPORT_INSET_PX,
      right: showsGcodeLayerColumn
        ? VIEWPORT_LAYER_COLUMN_RESERVE
        : (fullScreen ? DIALOG_CLOSE_CLEARANCE_PX : VIEWPORT_INSET_PX)
    },
    sceneProgress: {
      top: VIEWPORT_INSET_PX,
      left: VIEWPORT_INSET_PX,
      // Clears the viewport's own top-right controls: the full-screen toggle always, plus the
      // close button once full screen brings it down over that corner.
      right: fullScreen
        ? DIALOG_CLOSE_CLEARANCE_PX + DIALOG_CLOSE_FOOTPRINT_PX
        : DIALOG_CLOSE_CLEARANCE_PX
    },
    gcodeLayerColumn: {
      // Corner to corner down the right edge, so the slider keeps its travel on a short
      // viewport -- the full-screen toggle steps aside for this, not the other way round. The
      // close button is the one thing it yields to, and only where that button reaches it.
      top: fullScreen ? DIALOG_CLOSE_CLEARANCE_PX : VIEWPORT_INSET_PX,
      right: VIEWPORT_INSET_PX,
      bottom: VIEWPORT_INSET_PX
    },
    gcodeMovesStrip: {
      top: VIEWPORT_INSET_PX,
      left: VIEWPORT_INSET_PX,
      right: VIEWPORT_LAYER_COLUMN_RESERVE
    },
    gcodeConflictAlert: {
      // Stacked above the view cube's whole footprint, with a gap.
      bottom: VIEW_CUBE_FOOTPRINT_PX + 8,
      left: VIEWPORT_INSET_PX,
      right: showsGcodeLayerColumn ? VIEWPORT_LAYER_COLUMN_RESERVE : VIEWPORT_INSET_PX
    }
  }
}
