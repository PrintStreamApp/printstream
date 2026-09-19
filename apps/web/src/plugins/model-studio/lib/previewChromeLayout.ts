/**
 * Where the 3D preview's floating controls sit, as a function of which chrome is showing.
 *
 * The full-screen toggle, streaming progress and toolpath-conflict warning float over the viewport.
 * Their positions live here so the shared corner spacing cannot drift between controls.
 *
 * The G-code scrubbers deliberately do not appear here. They occupy grid tracks OUTSIDE the 3D
 * area in `PreviewView`, so treating them as floating controls would reserve the same space twice.
 *
 * Counterpart: `PreviewView.tsx`, which spreads these onto the controls.
 */

/** Inset every floating viewport control keeps from the edge it hugs. */
export const VIEWPORT_INSET_PX = 12

/** A floating icon control's own size: Joy's `md` IconButton. */
export const VIEWPORT_CONTROL_SIZE_PX = 32

/**
 * How far the view cube reaches into the viewport's bottom-left corner.
 *
 * `VIEW_CUBE_EDGE_INSET` (8) + `VIEW_CUBE_SIZE` (92) from `lib/viewCube.ts`, restated here rather
 * than imported because that module pulls in THREE and this one is pure (and unit-tested without
 * a renderer). `previewChromeLayout.test.ts` pins the number so the two cannot drift silently.
 *
 * Note this is much larger than the old reserve measured against the scrubbers: reusing that for
 * the cube put the conflict banner 24px INSIDE it, under a control
 * whose z-index is `tooltip`, so the cube covered the banner's warning icon and took its clicks.
 */
export const VIEW_CUBE_FOOTPRINT_PX = 100

/** A pixel inset, or one per breakpoint where the control's size changes with the viewport. */
export type ResponsiveInset = number | { xs: number; sm: number }

export interface PreviewChromeInput {
  /** Mobile adds a legend button immediately left of the full-screen control. */
  showLegendToggle?: boolean
}

export interface PreviewChromeLayout {
  /** Enlarges the 3D area alone, so it sits on the 3D area rather than in the dialog header. */
  fullScreenToggle: { top: number; right: ResponsiveInset }
  /** Slim bar along the top while the plate's parts stream in. */
  sceneProgress: { top: number; left: number; right: number }
  /**
   * The toolpath-conflict warning, sitting ABOVE the view cube along the bottom edge.
   *
   * Above rather than beside: the cube is 92px square, so clearing it horizontally would leave the
   * banner about 180px wide on a phone, and a wrapped four-line warning is then taller than what
   * it saved. Stacking keeps the full width and makes the horizontal collision impossible.
   */
  gcodeConflictAlert: { bottom: number; left: number; right: ResponsiveInset }
}

export function previewChromeLayout({
  showLegendToggle = false
}: PreviewChromeInput): PreviewChromeLayout {
  const legendRight = VIEWPORT_INSET_PX + VIEWPORT_CONTROL_SIZE_PX + 8
  return {
    fullScreenToggle: {
      top: VIEWPORT_INSET_PX,
      right: VIEWPORT_INSET_PX
    },
    sceneProgress: {
      top: VIEWPORT_INSET_PX,
      left: VIEWPORT_INSET_PX,
      // Clears the viewport's own top-right controls: full screen always, plus the mobile legend
      // toggle when it is present.
      right: showLegendToggle
        ? legendRight + VIEWPORT_CONTROL_SIZE_PX + 8
        : VIEWPORT_INSET_PX + VIEWPORT_CONTROL_SIZE_PX + 8
    },
    gcodeConflictAlert: {
      // Stacked above the view cube's whole footprint, with a gap.
      bottom: VIEW_CUBE_FOOTPRINT_PX + 8,
      left: VIEWPORT_INSET_PX,
      right: VIEWPORT_INSET_PX
    }
  }
}
