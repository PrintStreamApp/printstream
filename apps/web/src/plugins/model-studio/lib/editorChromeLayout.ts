/**
 * The desktop editor's grid geometry as a function of which chrome is showing.
 *
 * The editor lays plate strip / viewport / sidebar out as ONE grid whose areas flip with the
 * sidebar-side preference. Hiding a region therefore cannot be a `display: none` on that region —
 * its row or column would stay, leaving a gap where the plate strip used to be — so the template
 * itself has to change. That is three interacting strings (columns, rows, areas) x two breakpoints
 * x two toggles, which is exactly the kind of inline ternary pile that hides a wrong case.
 *
 * The VIEWPORT is always present: the WebGL canvas must never unmount when chrome is toggled, or the
 * scene is rebuilt and the user's camera is lost (the mobile branch hides its viewport with
 * `display: none` for the same reason). Counterpart: the toolbar toggles in `EditorView`.
 */

/** The editor grid's gutter in px — Joy's `gap: 1`. Named so the measuring side agrees with the CSS. */
export const EDITOR_GRID_GAP_PX = 8

/** Plate-strip footprint, in px, in each orientation (tile + padding + its scrollbar). */
export const PLATE_STRIP_HORIZONTAL_THICKNESS = 128
export const PLATE_STRIP_VERTICAL_THICKNESS = 116

/**
 * Aspect the 3D area aims for. A build plate is square and is viewed at an angle, with the toolbar
 * across the top and the view cube in a bottom corner — so a mildly landscape box frames it with the
 * least dead space. Used only to CHOOSE between two layouts, never to force a size.
 */
export const EDITOR_VIEWPORT_TARGET_ASPECT = 4 / 3

export type PlateStripOrientation = 'horizontal' | 'vertical'

/**
 * Which way the plate strip should run, given the space actually available.
 *
 * A horizontal strip costs height and a vertical one costs width, so the better choice depends on
 * the window: on a short, wide window a horizontal strip squeezes the viewport into a letterbox,
 * while on a tall one a vertical rail wastes width the viewport wanted. Scores both against
 * {@link EDITOR_VIEWPORT_TARGET_ASPECT} in LOG space, so "twice too wide" and "twice too tall" are
 * penalised equally — a linear distance would quietly favour wide layouts.
 */
export function choosePlateStripOrientation(input: {
  bodyWidth: number
  bodyHeight: number
  /** 0 when the sidebar is hidden. */
  sidebarWidth: number
  gap: number
  targetAspect?: number
}): PlateStripOrientation {
  const { bodyWidth, bodyHeight, sidebarWidth, gap } = input
  const target = input.targetAspect ?? EDITOR_VIEWPORT_TARGET_ASPECT
  // Unmeasured (first paint, or a hidden container): keep the layout the editor has always had.
  if (!(bodyWidth > 0) || !(bodyHeight > 0)) return 'horizontal'
  const columnWidth = bodyWidth - (sidebarWidth > 0 ? sidebarWidth + gap : 0)

  const horizontalWidth = columnWidth
  const horizontalHeight = bodyHeight - PLATE_STRIP_HORIZONTAL_THICKNESS - gap
  const verticalWidth = columnWidth - PLATE_STRIP_VERTICAL_THICKNESS - gap
  const verticalHeight = bodyHeight

  // A layout that leaves no viewport at all is not a candidate, whatever it scores.
  const horizontalViable = horizontalWidth > 0 && horizontalHeight > 0
  const verticalViable = verticalWidth > 0 && verticalHeight > 0
  if (!verticalViable) return 'horizontal'
  if (!horizontalViable) return 'vertical'

  const miss = (width: number, height: number): number => Math.abs(Math.log((width / height) / target))
  return miss(verticalWidth, verticalHeight) < miss(horizontalWidth, horizontalHeight) ? 'vertical' : 'horizontal'
}

export interface EditorGridLayout {
  gridTemplateColumns: { xs: string; sm: string }
  gridTemplateRows: { xs: string; sm: string }
  gridTemplateAreas: { xs: string; sm: string }
}

/** Grid template for the editor body. `showPlates`/`showPanel` are the visible-chrome toggles. */
export function buildEditorGridLayout(input: {
  sidebarSide: 'left' | 'right'
  sidebarWidth: number
  showPlates: boolean
  showPanel: boolean
  /** sm+ only; narrow widths always stack, where a rail would eat the viewport's width. */
  stripOrientation?: PlateStripOrientation
}): EditorGridLayout {
  const { sidebarSide, sidebarWidth, showPlates, showPanel } = input
  const stripOrientation = input.stripOrientation ?? 'horizontal'
  const viewportColumn = 'minmax(0, 1fr)'
  const panelColumn = `${sidebarWidth}px`

  // Stacked at xs: the panel is a row under the viewport rather than a column beside it.
  const xsRows = [showPlates ? 'auto' : null, viewportColumn, showPanel ? 'auto' : null].filter(Boolean).join(' ')
  const xsAreas = [showPlates ? '"plates"' : null, '"viewport"', showPanel ? '"panel"' : null].filter(Boolean).join(' ')

  // A vertical strip is a COLUMN beside the viewport, so it takes the single row the layout
  // already has; it sits on the side away from the sidebar, keeping both at the outer edges.
  if (showPlates && stripOrientation === 'vertical') {
    const stripColumn = `${PLATE_STRIP_VERTICAL_THICKNESS}px`
    const smColumnsVertical = showPanel
      ? (sidebarSide === 'left'
          ? `${panelColumn} ${viewportColumn} ${stripColumn}`
          : `${stripColumn} ${viewportColumn} ${panelColumn}`)
      : `${stripColumn} ${viewportColumn}`
    const smAreasVertical = showPanel
      ? (sidebarSide === 'left' ? '"panel viewport plates"' : '"plates viewport panel"')
      : '"plates viewport"'
    return {
      gridTemplateColumns: { xs: '1fr', sm: smColumnsVertical },
      gridTemplateRows: { xs: xsRows, sm: viewportColumn },
      gridTemplateAreas: { xs: xsAreas, sm: smAreasVertical }
    }
  }

  const smRows = showPlates ? `auto ${viewportColumn}` : viewportColumn
  const smColumns = showPanel
    ? (sidebarSide === 'left' ? `${panelColumn} ${viewportColumn}` : `${viewportColumn} ${panelColumn}`)
    : viewportColumn
  // The panel spans both rows so the plate strip sits beside it, not above it.
  const smAreas = showPanel
    ? (sidebarSide === 'left'
        ? (showPlates ? '"panel plates" "panel viewport"' : '"panel viewport"')
        : (showPlates ? '"plates panel" "viewport panel"' : '"viewport panel"'))
    : (showPlates ? '"plates" "viewport"' : '"viewport"')

  return {
    gridTemplateColumns: { xs: '1fr', sm: smColumns },
    gridTemplateRows: { xs: xsRows, sm: smRows },
    gridTemplateAreas: { xs: xsAreas, sm: smAreas }
  }
}
