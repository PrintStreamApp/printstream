/**
 * Leaf presentational sub-components for the 3MF plate editor.
 *
 * These render no editor state of their own beyond trivial local UI state (drag
 * highlight, a focused field's draft string): the plate thumbnail strip, the gizmo
 * toolbar and its buttons, the keyboard-shortcut help popup, the manual transform
 * panel and its axis inputs, and the object list. The per-plate filament-change/
 * pause sections and the filament option row live in the CORE
 * `components/library/PlateGcodeSections` (the prepare-print dialog renders them
 * too, and core must not import a plugin). Shared editor types/consts come from
 * ./editorGeometry; the filament-option shape is a type-only import from
 * ./EditorView (erased, no runtime cycle).
 */
import { Fragment, memo, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject } from 'react'
import {
  Box,
  Button,
  buttonClasses,
  ButtonGroup,
  Chip,
  CircularProgress,
  Dropdown,
  IconButton,
  iconButtonClasses,
  Input,
  List,
  ListDivider,
  ListItem,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  Sheet,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/joy'
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import { partMemberKey, type PartMember, type PartRef, type PartSelection } from './lib/selectionModel'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import DriveFileRenameOutlineRoundedIcon from '@mui/icons-material/DriveFileRenameOutlineRounded'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import LayersRoundedIcon from '@mui/icons-material/LayersRounded'
import TextFieldsRoundedIcon from '@mui/icons-material/TextFieldsRounded'
import ImageRoundedIcon from '@mui/icons-material/ImageRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded'
import NearMeRoundedIcon from '@mui/icons-material/NearMeRounded'
import OpenWithRoundedIcon from '@mui/icons-material/OpenWith'
import ThreeSixtyRoundedIcon from '@mui/icons-material/ThreeSixtyRounded'
import AspectRatioRoundedIcon from '@mui/icons-material/AspectRatioRounded'
import VerticalAlignBottomRoundedIcon from '@mui/icons-material/VerticalAlignBottomRounded'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import FlipRoundedIcon from '@mui/icons-material/FlipRounded'
import JoinInnerRoundedIcon from '@mui/icons-material/JoinInnerRounded'
import LockRoundedIcon from '@mui/icons-material/LockRounded'
import LockOpenRoundedIcon from '@mui/icons-material/LockOpenRounded'
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded'
import UnfoldLessRoundedIcon from '@mui/icons-material/UnfoldLessRounded'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'
import AdjustRoundedIcon from '@mui/icons-material/AdjustRounded'
import BlurOnRoundedIcon from '@mui/icons-material/BlurOnRounded'
import BrushRoundedIcon from '@mui/icons-material/BrushRounded'
import FormatPaintRoundedIcon from '@mui/icons-material/FormatPaintRounded'
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import TouchAppRoundedIcon from '@mui/icons-material/TouchAppRounded'
import type { LibraryFile, SceneEditHelperVolumeSubtype, SceneEditPartSubtype } from '@printstream/shared'
import { canonicalThreeMfPartSubtype, threeMfPartSubtypeCarriesFilament } from '@printstream/shared'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { useMobileViewport } from '../../components/useMobileViewport'
import { SettingsTuneButton } from '../../components/SettingsTuneButton'
import { ActionMenuButton } from '../../components/ActionMenuButton'
import { type ContextMenuAnchor } from './contextMenuChrome'
import { EDITOR_POPUP_Z_INDEX } from './editorLayers'
import { PART_SUBTYPE_OPTIONS, RESTING_GIZMO_MODE, type GizmoMode, type SelectedTransform, type TransformGizmoMode } from './editorGeometry'
import { HELPER_VOLUME_SPECS, helperVolumeCssColor } from './lib/helperVolumes'
import { BODY_PART_INDEX, addedPartHostId, effectivePartFilamentId, instanceVolumeRows, summarizeInstanceMaterial } from './lib/editorModel'
import type { EditorAddedPart, EditorInstance, EditorPlate } from './lib/editorModel'
import { PRIMITIVE_LABELS, type PrimitiveKind } from './lib/primitives'
import { plateDisplayName } from './lib/plateName'
import { useListReorderDrag, useSingleListReorderDrag, type ListReorderGroup } from '../../hooks/useListReorderDrag'
import { ListReorderCaret } from '../../components/ListReorderCaret'
import type { FilamentOption } from './EditorView'

/**
 * Hover rule for the tool rail: opens every button's collapsed label together, so the rail
 * behaves like an editor activity bar (hover anywhere → it widens) instead of one button
 * twitching wider at a time. Applied to the rail's container, which owns the hover state.
 */
export const RAIL_HOVER_LABEL_SX = {
  // `:has(:focus-visible)` rather than `:focus-within`: clicking a tool leaves that button
  // focused, and `:focus-within` then pinned the rail open long after the pointer had left.
  // This keeps the keyboard path (tabbing along the rail still opens the labels) without the
  // stuck-open mouse behaviour.
  '&:hover [data-tool-label], &:has(:focus-visible) [data-tool-label]': {
    maxWidth: '10rem',
    opacity: 1,
    marginInlineStart: '0.5rem'
  }
} as const

/** Shared height for the axis-group headers so Scale's lock button cannot misalign the row. */
const AXIS_HEADER_HEIGHT = 24

/** Floor for one axis field: fits a signed two-decimal value plus its axis letter. */
const AXIS_FIELD_MIN_WIDTH = 74

/** Width of the vertical tool rail (sm+): icon buttons plus the button group's own border. */
export const TOOL_RAIL_WIDTH = 40

/**
 * The object sidebar's drag groups: one for the OBJECT rows, and one per multi-part ROW for its
 * PART rows. A drag can only ever reorder within its own group, which is how BambuStudio's rule
 * that a volume never leaves its object (`ObjectList::can_drop`) is enforced.
 */
const OBJECT_LIST_GROUP = 'objects'
const partListGroup = (instanceKey: string): string => `parts:${instanceKey}`

/**
 * Anchor for the floating tool panels (cut / measure / paint / brim ears / added part) so they
 * always clear the tools, whichever way the tools are laid out: on phones the tools stay a
 * horizontal strip across the top, so the panels sit BELOW it; from `sm` up the tools live in the
 * vertical left rail (photo-editor style), so the panels sit BESIDE it and reclaim the top edge.
 */
export const TOOL_PANEL_ANCHOR = {
  // The phone strip WRAPS, so its height is not a constant: it grows with the button count and
  // shrinks with the viewport, and a hardcoded 52 (one row) put every panel under the toolbar's
  // second row the moment the tools group needed two. `EditorView` measures the strip and publishes
  // `--editor-chrome-height` on the viewport; the fallback is one row, for the frame before the
  // first measurement lands.
  top: { xs: 'calc(var(--editor-chrome-height, 44px) + 12px)', sm: 8 },
  left: { xs: 8, sm: TOOL_RAIL_WIDTH + 12 }
} as const


/**
 * Plate selector strip: a live thumbnail per plate (rendered offscreen from the
 * edited layout), with add-plate and per-plate delete. The selected plate is
 * highlighted. Reordering is pointer-based (mouse drag / touch hold-and-drag) and drops into
 * the gap BETWEEN tiles: see `useListReorderDrag`.
 */
export function PlateThumbnailStrip({
  plates,
  activeIndex,
  thumbnails,
  embeddedThumbnailUrl,
  onSelect,
  onAddPlate,
  onRemovePlate,
  onRenamePlate,
  onReorderPlate,
  orientation = 'horizontal'
}: {
  plates: EditorPlate[]
  activeIndex: number
  /** Live client-rendered previews, keyed by the plate's session identity (`plateId`). */
  thumbnails: Record<number, string>
  /** Embedded PNG URL for a plate's source thumbnail, or null when the 3MF has none. */
  embeddedThumbnailUrl: (plate: EditorPlate) => string | null
  onSelect: (index: number) => void
  onAddPlate: () => void
  onRemovePlate: (index: number) => void
  onRenamePlate: (index: number) => void
  /** Drop a plate into insertion gap `insertAt` (0-based, 0 = before the first plate). */
  onReorderPlate: (fromIndex: number, insertAt: number) => void
  /**
   * Which way the strip runs. Vertical is a rail beside the viewport, chosen by
   * `choosePlateStripOrientation` when a horizontal band would letterbox the 3D area. Only the
   * axis changes: tiles, collapse, drag-reorder and the options menu are identical.
   */
  orientation?: 'horizontal' | 'vertical'
}) {
  const vertical = orientation === 'vertical'
  const plateIndices = useMemo(() => plates.map((plate) => plate.index), [plates])
  const { drag, setContainerElement, setCaretElement, setTileElement, handleTilePointerDown, shouldSuppressClick } =
    useSingleListReorderDrag({ vertical, itemIndices: plateIndices, onDrop: onReorderPlate })
  // Which tile's options menu is open. Held here (rather than letting each Dropdown own its
  // state) so a right-click anywhere on a tile can open that tile's menu, the same menu the
  // kebab opens, so the two entry points can never drift apart.
  const [menuPlateIndex, setMenuPlateIndex] = useState<number | null>(null)
  // Collapsed mode trades the thumbnails for name-only chips so the 3D viewport gets the
  // vertical space back; the preference sticks across sessions.
  const [collapsed, setCollapsed] = useLocalStorageState(
    'bambu.editor.plateStripCollapsed',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  return (
    <Sheet
      variant="outlined"
      sx={{
        p: 0.75,
        borderRadius: 'sm',
        bgcolor: 'background.level1',
        width: '100%',
        minWidth: 0,
        // The rail owns its column's full height and scrolls inside it, so a long plate list
        // never stretches the grid row.
        ...(vertical ? { height: '100%', minHeight: 0, display: 'flex' } : {})
      }}
    >
    <Stack
      ref={setContainerElement}
      direction={vertical ? 'column' : 'row'}
      spacing={0.75}
      // `relative` anchors the drop caret, which positions in content coordinates so it scrolls
      // with the tiles it points between.
      sx={vertical
        ? { position: 'relative', overflowY: 'auto', overflowX: 'hidden', alignItems: 'stretch', flex: 1, minHeight: 0, width: '100%' }
        : { position: 'relative', overflowX: 'auto', alignItems: 'stretch' }}
    >
      {plates.map((plate) => {
        const active = plate.index === activeIndex
        // Prefer a live client-rendered thumbnail (the active plate + any plate the user has
        // opened/edited reflect the real layout); otherwise fall back to the 3MF's embedded
        // PNG so unopened plates don't have to be loaded + rendered just to fill the strip.
        // Both caches key on the plate's IDENTITY (plateId / source index), never its live
        // index, so reordering or removing plates can never leave an image on the wrong tile.
        const liveThumbnail = thumbnails[plate.plateId]
        const embedded = liveThumbnail ? null : embeddedThumbnailUrl(plate)
        const thumbnail = liveThumbnail ?? embedded
        // No live render and no embedded PNG means the plate is genuinely still loading
        // (e.g. a freshly added empty plate before it's opened): show a spinner.
        const loading = !thumbnail
        const label = plateDisplayName(plate.name, plate.index)
        return (
          <Sheet
            key={plate.plateId}
            ref={(element: HTMLElement | null) => setTileElement(plate.index, element)}
            // A div (not a <button>) because the tile contains the options MenuButton, and a
            // button nested in a button is invalid DOM. role/tabIndex/keydown keep it operable.
            component="div"
            role="button"
            tabIndex={0}
            variant={active ? 'solid' : 'outlined'}
            color={active ? 'primary' : 'neutral'}
            // A completed reorder drop synthesizes a click on this tile; selecting on it would
            // switch plates (a full scene rebuild) on top of the reorder's own switch.
            onClick={() => { if (!shouldSuppressClick()) onSelect(plate.index) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(plate.index) }
            }}
            // Right-click opens this tile's options menu WITHOUT selecting the plate, matching the
            // kebab (which stops propagation for the same reason): switching the active plate
            // rebuilds the scene, and renaming or deleting a plate does not require opening it.
            onContextMenu={(event) => { event.preventDefault(); setMenuPlateIndex(plate.index) }}
            onPointerDown={(event) => handleTilePointerDown(plate.index, event)}
            aria-label={`Select ${label}`}
            aria-current={active}
            sx={{
              // Expanded: fixed-width tile sized to the (square) thumbnail; the label must not
              // stretch it, so cap the width and let the label truncate within it. Collapsed:
              // a name-only chip with the options menu inline.
              // In a rail the tile fills the column's width and its HEIGHT is what must not
              // stretch; in a band it is the reverse. `flex` names the axis being fixed, so it
              // has to flip with the orientation or the tiles grow to fill the scroller.
              flex: '0 0 auto',
              width: vertical ? '100%' : (collapsed ? 'auto' : 92),
              minWidth: vertical ? 0 : (collapsed ? 0 : 92),
              maxWidth: vertical ? '100%' : (collapsed ? 160 : 92),
              p: 0.5,
              border: active ? undefined : '1px solid',
              borderColor: active ? undefined : 'neutral.outlinedBorder',
              appearance: 'none',
              borderRadius: 'sm',
              cursor: 'pointer',
              position: 'relative',
              display: 'flex',
              flexDirection: collapsed ? 'row' : 'column',
              alignItems: collapsed ? 'center' : undefined,
              gap: collapsed ? 0.5 : 0.25,
              // The tile is a drag handle: text selection would fight a mouse drag, and the
              // iOS long-press callout would fight the touch hold-to-drag.
              userSelect: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
              // Reorder feedback: dim the tile being dragged; the landing position is the caret
              // drawn in the target gap (a ring on a TILE read as "swap/put inside" and could
              // not say on which side the plate would land).
              ...(drag?.itemIndex === plate.index ? { opacity: 0.45 } : {})
            }}
          >
            {!collapsed && (
              <Box
                sx={{
                  aspectRatio: '1 / 1',
                  width: '100%',
                  borderRadius: 'xs',
                  overflow: 'hidden',
                  bgcolor: '#0d1322',
                  display: 'grid',
                  placeItems: 'center'
                }}
              >
                {thumbnail ? (
                  <Box
                    component="img"
                    src={thumbnail}
                    alt=""
                    // The tile owns the reorder drag; a draggable <img> would start a
                    // native image drag instead whenever the grab lands on the thumb.
                    draggable={false}
                    sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <CircularProgress size="sm" />
                )}
              </Box>
            )}
            {collapsed && loading && <CircularProgress size="sm" sx={{ flexShrink: 0, '--CircularProgress-size': '16px' }} />}
            <Tooltip title={label} variant="soft" size="sm">
              <Typography
                level="body-xs"
                noWrap
                textColor={active ? 'primary.50' : undefined}
                sx={{ textAlign: collapsed ? 'left' : 'center', width: '100%', minWidth: 0, maxWidth: '100%', px: collapsed ? 0.25 : 0 }}
              >
                {label}
              </Typography>
            </Tooltip>
            <Dropdown
              open={menuPlateIndex === plate.index}
              onOpenChange={(_event, isOpen) => setMenuPlateIndex(isOpen ? plate.index : null)}
            >
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{ root: {
                  size: 'sm',
                  variant: 'plain',
                  color: 'neutral',
                  onClick: (event: React.MouseEvent) => event.stopPropagation(),
                  // Pressing the kebab must not arm a reorder drag on the tile under it.
                  onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
                  'aria-label': `Plate ${plate.index} options`
                } }}
                sx={collapsed
                  ? { flexShrink: 0, minHeight: 22, minWidth: 22, '--IconButton-size': '22px' }
                  : { position: 'absolute', top: 2, right: 2, minHeight: 22, minWidth: 22, '--IconButton-size': '22px' }}
              >
                <MoreVertRoundedIcon fontSize="small" />
              </MenuButton>
              <Menu placement="bottom-end" sx={{ zIndex: EDITOR_POPUP_Z_INDEX, minWidth: 160 }} onClick={(event) => event.stopPropagation()}>
                {/* Lay out icon + label directly with a fixed gap so every row aligns
                    (ListItemDecorator sizes differently on the danger/selected row). */}
                <MenuItem onClick={(event) => { event.stopPropagation(); onRenamePlate(plate.index) }} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <DriveFileRenameOutlineRoundedIcon fontSize="small" />
                  Rename
                </MenuItem>
                {plates.length > 1 && (
                  <MenuItem color="danger" onClick={(event) => { event.stopPropagation(); onRemovePlate(plate.index) }} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <DeleteRoundedIcon fontSize="small" />
                    Delete plate
                  </MenuItem>
                )}
              </Menu>
            </Dropdown>
          </Sheet>
        )
      })}
      <Tooltip title="Add plate">
        <IconButton
          size={collapsed ? 'sm' : 'lg'}
          variant="outlined"
          color="neutral"
          onClick={onAddPlate}
          aria-label="Add plate"
          sx={{ flex: '0 0 auto', alignSelf: 'stretch' }}
        >
          <AddRoundedIcon />
        </IconButton>
      </Tooltip>
      <Tooltip title={collapsed ? 'Show plate previews' : 'Hide plate previews'}>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Show plate previews' : 'Hide plate previews'}
          // Push to the far END of the strip, which is a different axis per orientation: `ml` in a
          // row, `mt` in the rail's column. Using `ml` in both left the rail's button pinned to the
          // right edge, out of line with tiles that stretch the full width. `!important` beats the
          // margin Stack injects between children on whichever axis it is spacing.
          sx={vertical
            ? { flex: '0 0 auto', alignSelf: 'center', mt: 'auto !important' }
            : { flex: '0 0 auto', alignSelf: 'center', ml: 'auto !important' }}
        >
          {collapsed ? <UnfoldMoreRoundedIcon fontSize="small" /> : <UnfoldLessRoundedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <ListReorderCaret setCaretElement={setCaretElement} vertical={vertical} />
    </Stack>
    </Sheet>
  )
}

/** One entry in the viewport toolbar: a modal tool (active highlights) or a one-shot action. */
interface ToolbarEntry {
  key: string
  /** Full name, shown in the tooltip and aria-label. */
  label: string
  /** Compact caption under the icon; defaults to `label`. */
  short?: string
  icon: JSX.Element
  active?: boolean
  disabled: boolean
  onClick: () => void
}

/**
 * A toolbar button: icon-only on phones, icon above a small caption on desktop
 * (keeps each button narrow so the whole row fits typical editor widths: Joy
 * has no vertical-content button variant, hence the column-flex override).
 *
 * ButtonGroup rounds its corners by cloning DIRECT children with
 * `data-first-child`/`data-last-child` and styling `& > [data-*-child]`, those
 * attributes land on this component, so they must be forwarded to the real
 * button (still a direct DOM child: Tooltip renders no wrapper element).
 */
function ToolbarButton({ entry, layout, ...groupAttrs }: {
  entry: ToolbarEntry
  /**
   * `stacked`: icon above a caption (the desktop top strip).
   * `icon`: icon only (phones, where captions never fit).
   * `rail`: icon plus a label that stays collapsed until the rail is hovered; the rail
   *   container owns that hover rule (see RAIL_HOVER_LABEL_SX), so hovering anywhere on the
   *   rail expands every button together rather than one at a time.
   */
  layout: 'stacked' | 'icon' | 'rail'
  'data-first-child'?: string
  'data-last-child'?: string
}) {
  const variant = entry.active ? ('solid' as const) : ('soft' as const)
  const color = entry.active ? ('primary' as const) : ('neutral' as const)
  const railLabel = entry.short ?? entry.label
  // In the rail the label is already on screen while hovering, so a tooltip repeating it is
  // just noise: keep one only where the full label says more than the short caption.
  const tooltipTitle = layout === 'rail' && railLabel === entry.label ? '' : entry.label
  return (
    <Tooltip title={tooltipTitle} placement={layout === 'rail' ? 'right' : 'bottom'}>
      {layout === 'rail' ? (
        <Button
          {...groupAttrs}
          variant={variant}
          color={color}
          disabled={entry.disabled}
          onClick={entry.onClick}
          aria-label={entry.label}
          sx={{
            justifyContent: 'flex-start',
            gap: 0,
            px: 0.75,
            py: 0.5,
            minWidth: 0,
            '--Icon-fontSize': '1.125rem'
          }}
        >
          {entry.icon}
          <Box
            component="span"
            data-tool-label
            sx={{
              // Collapsed by default; the rail's :hover rule opens it. Animating max-width
              // (not width) keeps the label's natural size while still being transitionable.
              maxWidth: 0,
              opacity: 0,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              fontSize: '0.75rem',
              lineHeight: 1.2,
              transition: 'max-width 160ms ease, opacity 120ms ease, margin-inline-start 160ms ease',
              '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
            }}
          >
            {railLabel}
          </Box>
        </Button>
      ) : layout === 'icon' ? (
        <IconButton {...groupAttrs} variant={variant} color={color} disabled={entry.disabled} onClick={entry.onClick} aria-label={entry.label}>
          {entry.icon}
        </IconButton>
      ) : (
        <Button
          {...groupAttrs}
          variant={variant}
          color={color}
          disabled={entry.disabled}
          onClick={entry.onClick}
          aria-label={entry.label}
          sx={{
            flexDirection: 'column',
            gap: 0.25,
            minWidth: 0,
            px: 1,
            py: 0.5,
            '--Icon-fontSize': '1.125rem'
          }}
        >
          {entry.icon}
          <Box component="span" sx={{ fontSize: '0.625rem', lineHeight: 1.1, whiteSpace: 'nowrap' }}>
            {entry.short ?? entry.label}
          </Box>
        </Button>
      )}
    </Tooltip>
  )
}

export function GizmoToolbar({
  mode,
  disabled,
  busy,
  arrangeDisabled,
  onChange,
  onDropToBed,
  onAutoOrient,
  onArrangeAll,
  orientation = 'horizontal'
}: {
  mode: GizmoMode
  disabled: boolean
  /** Disables even selection-independent tools (measure) while the viewport is busy. */
  busy: boolean
  /** Auto-arrange is plate-scoped: enabled whenever the plate has objects, selection or not. */
  arrangeDisabled: boolean
  onChange: (mode: GizmoMode) => void
  onDropToBed: () => void
  onAutoOrient: () => void
  onArrangeAll: () => void
  /**
   * `vertical` is the photo-editor left rail (sm+): icon-only buttons stacked down the
   * viewport's left edge. `horizontal` is the phone layout, a wrapping strip across the top.
   */
  orientation?: 'horizontal' | 'vertical'
}) {
  const isMobile = useMobileViewport()
  // Captions would make the rail far too wide, so the vertical form is icon-only like phones.
  const layout = orientation === 'vertical' ? ('rail' as const) : isMobile ? ('icon' as const) : ('stacked' as const)
  // Selection tools. All but the first need a selected object: the modal editing tools (the active
  // one highlights) plus the one-shot Drop/Orient actions.
  const tools: ToolbarEntry[] = [
    // The resting tool, and the only one here that works with nothing selected -- picking things is
    // exactly what you do before there IS a selection. BambuStudio has no button for this (its
    // `Undefined` state is reached by toggling the active gizmo off, which the entries below also
    // do); we show one because our rail is a toggle group where something is always lit, so "no
    // tool" would render as nothing lit, which reads as broken rather than as a mode.
    {
      key: RESTING_GIZMO_MODE,
      label: 'Select',
      icon: <NearMeRoundedIcon />,
      active: mode === RESTING_GIZMO_MODE,
      disabled: busy,
      onClick: () => onChange(RESTING_GIZMO_MODE)
    },
    ...([
      { value: 'translate', label: 'Move', icon: <OpenWithRoundedIcon /> },
      { value: 'rotate', label: 'Rotate', icon: <ThreeSixtyRoundedIcon /> },
      { value: 'scale', label: 'Scale', icon: <AspectRatioRoundedIcon /> },
      // Tap-a-face icon: the tool rests the CLICKED face on the bed. The plane-
      // through-a-shape icon (Flip) reads as slicing, so it marks the Cut tool.
      { value: 'layFace', label: 'Place on face', short: 'Lay flat', icon: <TouchAppRoundedIcon /> },
      { value: 'cut', label: 'Cut', icon: <FlipRoundedIcon /> },
      // Beside Cut: both reshape the geometry itself rather than painting or placing it, and
      // BambuStudio carries its own `GLGizmoMeshBoolean` in the same toolbar.
      { value: 'meshBoolean', label: 'Boolean', icon: <JoinInnerRoundedIcon /> },
      { value: 'paintSupports', label: 'Paint supports', short: 'Supports', icon: <BrushRoundedIcon /> },
      { value: 'paintSeam', label: 'Paint seam', short: 'Seam', icon: <FormatPaintRoundedIcon /> },
      { value: 'paintColor', label: 'Paint color', short: 'Color', icon: <PaletteRoundedIcon /> },
      { value: 'paintFuzzy', label: 'Paint fuzzy skin', short: 'Fuzzy', icon: <BlurOnRoundedIcon /> },
      { value: 'brimEars', label: 'Brim ears', icon: <AdjustRoundedIcon /> },
      // BambuStudio carries layers editing in this same toolbar (`layersediting`), and it belongs
      // here for the same reason the others do: it is an exclusive mode, so the rail is where a user
      // looks to see that they are IN it. Reached from the object context menu too.
      { value: 'layerHeight', label: 'Variable layer height', short: 'Layers', icon: <LayersRoundedIcon /> },
    ] as Array<{ value: GizmoMode; label: string; short?: string; icon: JSX.Element }>).map((tool) => ({
      key: tool.value,
      label: tool.label,
      short: tool.short,
      icon: tool.icon,
      active: mode === tool.value,
      disabled,
      // Clicking the lit tool toggles back to resting, as `open_gizmo` does.
      onClick: () => onChange(mode === tool.value ? RESTING_GIZMO_MODE : tool.value)
    })),
    { key: 'drop', label: 'Drop to bed', short: 'Drop', icon: <VerticalAlignBottomRoundedIcon />, disabled, onClick: onDropToBed },
    { key: 'orient', label: 'Auto-orient (rest on the largest flat face)', short: 'Orient', icon: <AutoFixHighRoundedIcon />, disabled, onClick: onAutoOrient }
  ]
  // Utilities that work without a selection: plate-wide arrange and measure
  // (still a mode, it highlights while active, but it never edits the scene).
  const utilities: ToolbarEntry[] = [
    { key: 'arrange', label: 'Auto-arrange all objects on this plate', short: 'Arrange', icon: <GridViewRoundedIcon />, disabled: arrangeDisabled, onClick: onArrangeAll },
    { key: 'measure', label: 'Measure', icon: <StraightenRoundedIcon />, active: mode === 'measure', disabled: busy, onClick: () => onChange(mode === 'measure' ? RESTING_GIZMO_MODE : 'measure') },
    // Text needs no selection: with nothing selected it makes a model of its own, so it belongs
    // with the utilities rather than the selection tools.
    { key: 'text', label: 'Add text', short: 'Text', icon: <TextFieldsRoundedIcon />, active: mode === 'text', disabled: busy, onClick: () => onChange(mode === 'text' ? RESTING_GIZMO_MODE : 'text') },
    // Beside Text for the same reason, and because they are the same gesture: extrude a 2D source
    // onto the model, or onto the plate when nothing is selected.
    { key: 'svg', label: 'Add SVG', short: 'SVG', icon: <ImageRoundedIcon />, active: mode === 'svg', disabled: busy, onClick: () => onChange(mode === 'svg' ? RESTING_GIZMO_MODE : 'svg') }
  ]
  // The two groups are returned as siblings (no wrapper) so the toolbar's
  // flex-wrap container can break them onto separate rows on phones instead of
  // pushing the second group out of view. The slightly smaller phone buttons
  // let the 11-button tools group fit a 360px viewport on one row.
  const groupSx = {
    '--ButtonGroup-radius': 'var(--joy-radius-sm)',
    // Joy fades each button's divider to the near-invisible disabled border color
    // whenever that button is disabled; with the whole tools group disabled (no
    // object selected) that erased every divider. Pin the divider to the normal
    // outlined border regardless of disabled state so the toolbar always reads as
    // a connected row. `&&` outranks Joy's own `:disabled` separator rule.
    [`&& .${buttonClasses.root}:disabled, && .${iconButtonClasses.root}:disabled`]: {
      '--ButtonGroup-separatorColor': 'var(--joy-palette-neutral-outlinedBorder)'
    },
    ...(layout === 'icon' ? { '--IconButton-size': '30px' } : null)
  }
  const groups = (
    <>
      <ButtonGroup size="sm" variant="soft" orientation={orientation} sx={groupSx}>
        {tools.map((entry) => <ToolbarButton key={entry.key} entry={entry} layout={layout} />)}
      </ButtonGroup>
      <ButtonGroup size="sm" variant="soft" orientation={orientation} sx={groupSx}>
        {utilities.map((entry) => <ToolbarButton key={entry.key} entry={entry} layout={layout} />)}
      </ButtonGroup>
    </>
  )
  // Vertical: own the column layout so the two groups stack with a gap. Horizontal: stay
  // wrapper-free so the caller's flex-wrap strip can break the groups onto separate rows.
  return orientation === 'vertical' ? <Stack spacing={1}>{groups}</Stack> : groups
}

/** A small "?" affordance documenting the editor keyboard shortcuts. */
/** A single keyboard-key chip, styled like markdown `code`/`<kbd>`. */
function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="kbd"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: 0.5,
        minWidth: '1.4em',
        justifyContent: 'center',
        borderRadius: 'xs',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
        borderBottomWidth: 2,
        bgcolor: 'background.level1',
        fontFamily: 'code',
        fontSize: '0.7rem',
        lineHeight: 1.7,
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </Box>
  )
}

export function KeyboardHelpButton() {
  const shortcuts: Array<{ keys: string[]; description: string }> = [
    { keys: ['↑', '↓', '←', '→'], description: 'Move on bed' },
    { keys: ['Shift', '↑↓←→'], description: 'Move farther' },
    { keys: ['Ctrl/Cmd', '↑↓←→'], description: 'Fine move' },
    { keys: ['[', ']'], description: 'Rotate about Z' },
    { keys: ['Del'], description: 'Remove' },
    { keys: ['Shift'], description: 'Snap 45° while rotating' }
  ]
  // Click-driven popup (not a hover Tooltip) so it also opens on touch devices.
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{ root: { size: 'sm', variant: 'soft', color: 'neutral', 'aria-label': 'Keyboard shortcuts' } }}
      >
        <HelpOutlineRoundedIcon />
      </MenuButton>
      <Menu placement="bottom-start" sx={{ zIndex: EDITOR_POPUP_Z_INDEX, p: 1.25, maxWidth: 280 }}>
        <Typography level="title-sm" sx={{ mb: 0.75 }}>Keyboard shortcuts</Typography>
        <Stack spacing={0.5}>
          {shortcuts.map((shortcut) => (
            <Stack key={shortcut.description} direction="row" spacing={0.75} alignItems="center">
              <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
                {shortcut.keys.map((key, index) => (
                  <KeyCap key={`${shortcut.description}-${index}`}>{key}</KeyCap>
                ))}
              </Stack>
              <Typography level="body-xs">{shortcut.description}</Typography>
            </Stack>
          ))}
        </Stack>
      </Menu>
    </Dropdown>
  )
}

/**
 * Manual transform readout for the selected object: position (mm), rotation (deg), or per-axis
 * scale (%) with a uniform-lock toggle. Editing a field updates the live object + gizmo; values
 * reflect the current gizmo state.
 *
 * Shows the ONE group the active tool edits, not all three. BambuStudio does show all three at
 * once, but its panel is a docked sidebar with room for them; ours floats over the viewport, where
 * two-thirds of the widest chrome on screen being inert readouts costs the user real bed space and
 * invites edits that the current gizmo will not reflect.
 */
export function TransformPanel({
  transform,
  mode,
  heading,
  uniformScale,
  onToggleUniformScale,
  onPosition,
  onRotation,
  onScale,
  floating = false
}: {
  transform: SelectedTransform
  /** Which tool is active, and therefore which axis group this panel shows. */
  mode: TransformGizmoMode
  /**
   * Shown above the rows when the values describe something other than the selected
   * object: e.g. a selected PART's object-local placement (BambuStudio's "Volume
   * Operations" title). Omitted for the plain object transform.
   */
  heading?: string
  uniformScale: boolean
  onToggleUniformScale: (value: boolean) => void
  onPosition: (axis: 'x' | 'y' | 'z', value: number) => void
  onRotation: (axis: 'x' | 'y' | 'z', value: number) => void
  onScale: (axis: 'x' | 'y' | 'z', value: number) => void
  /**
   * Floating over the viewport (the sm+ placement, top-centre) rather than docked in the
   * sidebar: an elevated soft card with a shadow so it reads over the 3D scene, and tighter
   * gaps so it stays compact.
   */
  floating?: boolean
}) {
  return (
    <Sheet
      variant={floating ? 'soft' : 'outlined'}
      sx={{
        p: floating ? 0.75 : 1,
        borderRadius: 'sm',
        display: 'flex',
        flexDirection: 'column',
        gap: floating ? 0.5 : 1,
        ...(floating ? { boxShadow: 'md' } : {})
      }}
    >
      {heading && <Typography level="body-xs" sx={{ fontWeight: 600 }}>{heading}</Typography>}
      {mode === 'translate' && (
        <AxisGroup label="Position (mm)" values={transform.position} step={1} onChange={onPosition} />
      )}
      {mode === 'rotate' && (
        <AxisGroup label="Rotation (°)" values={transform.rotationDeg} step={1} onChange={onRotation} />
      )}
      {mode === 'scale' && (
        <AxisGroup
          label="Scale (%)"
          values={transform.scalePct}
          step={1}
          onChange={onScale}
          action={
            <Tooltip title={uniformScale ? 'Uniform scale (locked)' : 'Independent axes'}>
              <IconButton
                size="sm"
                variant={uniformScale ? 'solid' : 'outlined'}
                color={uniformScale ? 'primary' : 'neutral'}
                onClick={() => onToggleUniformScale(!uniformScale)}
                aria-label="Toggle uniform scale"
                aria-pressed={uniformScale}
                sx={{ flexShrink: 0, '--IconButton-size': `${AXIS_HEADER_HEIGHT}px` }}
              >
                {uniformScale ? <LockRoundedIcon fontSize="small" /> : <LockOpenRoundedIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          }
        />
      )}
    </Sheet>
  )
}

/**
 * Performance wrapper around {@link TransformPanel} that OWNS the live transform values.
 *
 * The readout updates at drag frequency (~30x/sec). If those values lived in EditorView's state,
 * every tick would re-render the whole editor, including the object/part sidebar, which for a
 * many-part model is hundreds of Joy rows and janks the drag. Instead this component holds the
 * value locally and exposes its setter through `setterRef`, so the render loop pushes live values
 * straight here without touching EditorView. `initial` seeds it (and re-seeds on selection change,
 * which is low-frequency); during a drag `initial` is stable, so the seed effect never fights the
 * live pushes. Returns null until a value exists (mirrors the old `selectedTransform && …` gate).
 */
export function LiveTransformPanel({
  initial,
  setterRef,
  ...panelProps
}: {
  initial: SelectedTransform | null
  /** EditorView-owned ref the render loop calls to push live values without a React re-render. */
  setterRef: MutableRefObject<((value: SelectedTransform | null) => void) | null>
} & Omit<Parameters<typeof TransformPanel>[0], 'transform'>) {
  const [transform, setTransform] = useState<SelectedTransform | null>(initial)
  // Re-seed when the selection changes (new `initial`); stable during a drag so live pushes win.
  useEffect(() => { setTransform(initial) }, [initial])
  // Publish the setter so EditorView's throttled panel sync can drive values imperatively.
  useEffect(() => {
    setterRef.current = setTransform
    return () => { if (setterRef.current === setTransform) setterRef.current = null }
  }, [setterRef])
  if (!transform) return null
  return <TransformPanel transform={transform} {...panelProps} />
}

/**
 * One labelled axis group (Position / Rotation / Scale).
 *
 * The header is a fixed-height row so every group's inputs sit on the same baseline:
 * Scale carries the uniform-lock button, and without a pinned height that one button made
 * its header taller and pushed the Scale fields out of line with the other two.
 */
function AxisGroup({
  label,
  action,
  values,
  step,
  onChange
}: {
  label: string
  /** Optional header control (Scale's uniform-lock toggle); must fit AXIS_HEADER_HEIGHT. */
  action?: React.ReactNode
  values: { x: number; y: number; z: number }
  step: number
  onChange: (axis: 'x' | 'y' | 'z', value: number) => void
}) {
  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        spacing={0.5}
        sx={{ minHeight: AXIS_HEADER_HEIGHT }}
      >
        <Typography level="body-xs" textColor="text.tertiary" noWrap>{label}</Typography>
        {action}
      </Stack>
      <AxisInputs values={values} step={step} onChange={onChange} />
    </Stack>
  )
}

function AxisInputs({
  values,
  step,
  onChange
}: {
  values: { x: number; y: number; z: number }
  step: number
  onChange: (axis: 'x' | 'y' | 'z', value: number) => void
}) {
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z']
  return (
    <Stack direction="row" spacing={0.5}>
      {axes.map((axis) => (
        <NumberField
          key={axis}
          axis={axis}
          value={values[axis]}
          step={step}
          onCommit={(value) => onChange(axis, value)}
        />
      ))}
    </Stack>
  )
}

/**
 * A controlled numeric field that shows the live value but commits the user's edit
 * on change/blur. Keeps a local string while focused so dragging the gizmo does
 * not overwrite mid-edit, then snaps back to the live value on blur.
 */
function NumberField({
  axis,
  value,
  step,
  onCommit
}: {
  axis: 'x' | 'y' | 'z'
  value: number
  step: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? roundForDisplay(value)
  return (
    <Input
      size="sm"
      type="number"
      slotProps={{ input: { step, 'aria-label': `${axis.toUpperCase()} axis` } }}
      value={display}
      onFocus={() => setDraft(roundForDisplay(value))}
      onChange={(event) => {
        setDraft(event.target.value)
        const parsed = Number.parseFloat(event.target.value)
        if (Number.isFinite(parsed)) onCommit(parsed)
      }}
      onBlur={() => setDraft(null)}
      startDecorator={<Typography level="body-xs" textColor="text.tertiary">{axis.toUpperCase()}</Typography>}
      sx={{
        // Room for a signed two-decimal value ("-152.57") plus the axis letter. Without a
        // floor the flex row squeezed these until every value ellipsised to "1…".
        flex: 1,
        minWidth: AXIS_FIELD_MIN_WIDTH,
        '--Input-decoratorChildHeight': '1rem',
        '--Input-paddingInline': '0.375rem',
        '--Input-gap': '0.25rem',
        // An <input> should scroll its value, never ellipsise it.
        '& input': { minWidth: 0, textOverflow: 'clip' }
      }}
    />
  )
}

function roundForDisplay(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

/**
 * "Add" menu button: every add path is a menu row, so one click always opens the menu.
 *
 * `ActionMenuButton`, not `SplitButton`, for the reason that component documents: there is no
 * action "Add" names on its own. It WAS a split button whose wide half opened the library picker
 * and silently fell through to the file picker on a host without one, so the same control did two
 * different things depending on where it was mounted, with nothing on screen saying which.
 */
export function AddObjectMenu({
  importing,
  disabled = false,
  disabledReason,
  onAddFromLibrary,
  onImportFile,
  onAddPrimitive
}: {
  importing: boolean
  /** Blocks adding objects (e.g. BambuStudio parity: a project needs a material first). */
  disabled?: boolean
  disabledReason?: string
  /**
   * Omitted on a host with no library (`EditorImportStore.supportsLibrarySource`), which hides that
   * row. Nothing else changes: the remaining rows are the whole control either way, which is why
   * it no longer needs a fallback for a primary action that does not exist.
   */
  onAddFromLibrary?: () => void
  onImportFile: () => void
  onAddPrimitive: (kind: PrimitiveKind) => void
}) {
  return (
    // Soft: the panel's Add is not the editor's primary action.
    <ActionMenuButton
      ariaLabel="add object"
      label="Add"
      size="sm"
      variant="soft"
      startDecorator={<AddRoundedIcon />}
      loading={importing}
      // An import already has the editor busy staging geometry, so starting a second one is not a
      // useful thing to reach mid-flight.
      disabled={importing || disabled}
      disabledReason={disabled ? disabledReason : undefined}
      // The editor is a Modal (zIndex 1300); the menu popper defaults to the lower `popup` layer,
      // so lift it above the dialog or it renders behind it. The icon column is pinned because
      // Joy's ListItemDecorator reserves height but not width, which leaves labels ragged.
      menuSx={{
        minWidth: 220,
        zIndex: EDITOR_POPUP_Z_INDEX,
        [`& .${listItemDecoratorClasses.root}`]: { minInlineSize: '1.75rem' },
        '& svg': { fontSize: '1.25rem' }
      }}
    >
      {onAddFromLibrary && (
        <MenuItem onClick={onAddFromLibrary}>
          <ListItemDecorator><InventoryRoundedIcon /></ListItemDecorator>
          From library…
        </MenuItem>
      )}
      <MenuItem onClick={onImportFile}>
        <ListItemDecorator><UploadFileRoundedIcon /></ListItemDecorator>
        Upload local file…
      </MenuItem>
      <ListDivider />
      {(Object.keys(PRIMITIVE_LABELS) as PrimitiveKind[]).map((kind) => (
        <MenuItem key={kind} onClick={() => onAddPrimitive(kind)}>
          <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
          Add {PRIMITIVE_LABELS[kind].toLowerCase()}
        </MenuItem>
      ))}
    </ActionMenuButton>
  )
}

/**
 * "Save": a menu of overwrite / save-as, or a plain button when only one of them is possible.
 *
 * Not a split button, and not because of consistency with its neighbours: "Save" names a category
 * here, not one action. Overwriting the open file and writing a new one are peers, and the split
 * form had to pick between them for the wide half based on whether a version could be saved, so the
 * same button did two different things depending on project state.
 *
 * A project with nothing to overwrite -- a new one, or any host that cannot write a version -- has
 * no category to name: the menu holds one row, so the caret asks the user to choose between an
 * option and itself and puts a click in front of the editor's most common action. Same collapse,
 * and for the same reason, as `SliceMenuButton` with a single plate.
 */
export function SaveMenuButton({
  saving,
  disabled,
  dirty,
  canSaveVersion,
  onSaveVersion,
  onSaveAs
}: {
  saving: boolean
  disabled: boolean
  /** Whether there are unsaved edits. Greys the primary "Save" (version) action when false. */
  dirty: boolean
  canSaveVersion: boolean
  onSaveVersion: () => void
  onSaveAs: () => void
}) {
  // Solid primary: Save is the footer's primary action (Slice sits soft to its left).
  // "Save" overwrites the open file, so it greys out until there are unsaved edits (matching
  // BambuStudio's Ctrl+S) while "Save as new…" always stays available, both as the new-project
  // path and as a safety valve if a change ever slips past dirty tracking. As ONE greyed row in a
  // menu that need not say why: the user opened the list and can see the live alternative next to
  // it, where the split form had to grey the whole control and explain itself in a tooltip.
  const saveVersionDisabled = disabled || saving || !dirty
  if (!canSaveVersion) {
    // Same variant, decorator and loading/disabled behaviour as the menu form, so the footer does
    // not change shape with the project. It saves as new, which is the only thing it could do.
    return (
      <Button
        type="button"
        variant="solid"
        color="primary"
        aria-label="save"
        startDecorator={<SaveRoundedIcon />}
        loading={saving}
        disabled={disabled || saving}
        onClick={onSaveAs}
      >
        Save
      </Button>
    )
  }
  return (
    <ActionMenuButton
      ariaLabel="save"
      label="Save"
      startDecorator={<SaveRoundedIcon />}
      loading={saving}
      disabled={disabled || saving}
      menuSx={{ zIndex: EDITOR_POPUP_Z_INDEX }}
    >
      <MenuItem disabled={saveVersionDisabled} onClick={onSaveVersion}>Save</MenuItem>
      <MenuItem onClick={onSaveAs}>Save as new…</MenuItem>
    </ActionMenuButton>
  )
}

/**
 * "Slice": a menu of this-plate / all-plates, or a plain button when there is only one plate.
 *
 * The menu exists because "Slice" then names a CATEGORY rather than an action, which is the rule
 * `ActionMenuButton` encodes. With a single plate that stops being true: both rows do the identical
 * thing, so the menu asks the user to pick between a choice and itself, and puts a click in front of
 * the editor's most common action. One plate is also the common case.
 */
export function SliceMenuButton({
  slicing,
  disabled,
  disabledReason,
  plateCount,
  onSliceAll,
  onSlicePlate
}: {
  slicing: boolean
  disabled: boolean
  disabledReason?: string
  /** How many plates the project has; 1 collapses the menu to a plain button. */
  plateCount: number
  onSliceAll: () => void
  onSlicePlate: () => void
}) {
  if (plateCount <= 1) {
    // Same variant, decorator and loading/disabled behaviour as the menu form, so the footer does
    // not change shape with the plate count. The disabled tooltip needs its own wrapper for the
    // reason `ActionMenuButton` documents: a disabled button swallows the hover.
    const button = (
      <Button
        type="button"
        variant="soft"
        color="primary"
        aria-label="slice"
        startDecorator={<LayersRoundedIcon />}
        loading={slicing}
        disabled={disabled}
        onClick={onSlicePlate}
      >
        Slice
      </Button>
    )
    return disabled && disabledReason
      ? (
        <Tooltip title={disabledReason} variant="soft" sx={{ maxWidth: 280 }}>
          <Box sx={{ display: 'inline-flex' }}>{button}</Box>
        </Tooltip>
      )
      : button
  }
  return (
    // Soft: Save (solid, rightmost) is the footer's primary action. Both rows gate together:
    // slicing one plate and slicing all of them are unavailable for the same reasons. Deliberately
    // NOT disabled while a slice runs -- queueing another plate mid-slice is legitimate, which is
    // why `loading` and `disabled` are separate.
    <ActionMenuButton
      ariaLabel="slice"
      variant="soft"
      label="Slice"
      startDecorator={<LayersRoundedIcon />}
      loading={slicing}
      disabled={disabled}
      disabledReason={disabledReason}
      menuPlacement="top-end"
      menuSx={{ zIndex: EDITOR_POPUP_Z_INDEX }}
    >
      <MenuItem onClick={onSlicePlate}>Slice this plate</MenuItem>
      <MenuItem onClick={onSliceAll}>Slice all plates</MenuItem>
    </ActionMenuButton>
  )
}

/** STL, STEP, and 3MF library files can be imported as parts (STEP is tessellated server-side). */
// eslint-disable-next-line react-refresh/only-export-components -- pure leaf helper colocated with the panels that use it.
export function isImportableLibraryFile(file: LibraryFile): boolean {
  if (file.kind === 'stl' || file.kind === 'step' || file.kind === '3mf') return true
  // Fallback for STEP files uploaded before they became a first-class kind (kind === 'other').
  const lower = file.name.toLowerCase()
  return file.kind === 'other' && (lower.endsWith('.step') || lower.endsWith('.stp'))
}

/** Readable text color (black/white) for a filament swatch background. */
function filamentTextColor(hex: string | null): string {
  const m = hex ? /^#?([0-9a-f]{6})$/i.exec(hex.trim()) : null
  if (!m) return '#fff'
  const n = parseInt(m[1] ?? '0', 16)
  const luminance = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return luminance > 150 ? '#11181f' : '#fff'
}

/**
 * Small swatch showing a part/object's filament number, tinted with its colour.
 * When `onReassign` + `options` are supplied it becomes a button that opens a
 * filament picker so the user can reassign the material.
 */
function FilamentBadge({
  filamentId,
  color,
  options,
  onReassign,
  title,
  mixedColors
}: {
  filamentId: number | null
  color: string | null
  options?: FilamentOption[]
  onReassign?: (filamentId: number) => void
  title?: string
  /**
   * INDETERMINATE state for a multi-part object whose parts do not all share one material:
   * the distinct part colours, painted as a gradient across the swatch instead of a single
   * fill + material number. A object whose parts DO agree passes a plain `filamentId`/`color`
   * like any single-material row, so the badge always says something truthful about the
   * object rather than the bare "+" it used to show for every multi-part object.
   */
  mixedColors?: string[]
}) {
  const interactive = Boolean(onReassign && options && options.length > 0)
  const mixed = Boolean(mixedColors && mixedColors.length > 1)
  if (filamentId == null && !mixed && !interactive) return null
  // The digit users see is the material's POSITION in the sidebar order, not the session id:
  // the two diverge after a mid-session remove/reorder (ids stay stable until the save
  // renumbers). Falls back to the id only when the caller has no options list to derive from.
  const displayNumber = filamentId == null
    ? null
    : options?.find((option) => option.id === filamentId)?.number ?? filamentId
  const swatch = (
    <Box
      sx={{
        flexShrink: 0,
        width: 20,
        height: 20,
        borderRadius: '4px',
        // A hard-stop gradient reads as "several materials" without inventing an icon; the
        // stops are evenly split so 2-4 colours each get a clear band.
        ...(mixed
          ? { background: buildMixedSwatchGradient(mixedColors!) }
          : { bgcolor: color || 'neutral.softBg' }),
        border: '1px solid rgba(255,255,255,0.18)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {!mixed && (
        <Typography level="body-xs" sx={{ fontWeight: 700, lineHeight: 1, color: filamentTextColor(color) }}>
          {displayNumber ?? '+'}
        </Typography>
      )}
    </Box>
  )
  if (!interactive) {
    return <Tooltip title={title ?? (mixed ? 'Mixed materials' : `Material ${displayNumber}`)}>{swatch}</Tooltip>
  }
  return (
    <Dropdown>
      <Tooltip title={title ?? (mixed ? 'Mixed materials: choose one for every part' : 'Change material')}>
        <MenuButton
          variant="plain"
          color="neutral"
          aria-label={title ?? 'Change material'}
          sx={{ p: 0, minHeight: 0, minWidth: 0, border: 'none', background: 'none', '&:hover': { background: 'none' }, flexShrink: 0 }}
        >
          {swatch}
        </MenuButton>
      </Tooltip>
      <Menu placement="bottom-end" sx={{ zIndex: EDITOR_POPUP_Z_INDEX, minWidth: 180 }}>
        {options!.map((option) => (
          <MenuItem
            key={option.id}
            selected={option.id === filamentId}
            onClick={() => onReassign!(option.id)}
            // Lay out the swatch + label directly with a fixed gap so every row aligns
            // (ListItemDecorator sized differently on the selected row).
            sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
          >
            <Box sx={{ flexShrink: 0, width: 16, height: 16, borderRadius: '3px', bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
            <span>Material {option.number}{option.label ? `: ${option.label}` : ''}{option.colorName ? ` (${option.colorName})` : ''}</span>
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  )
}

/** Even hard-stop bands across up to four distinct part colours (see FilamentBadge's mixed mode). */
function buildMixedSwatchGradient(colors: string[]): string {
  const bands = colors.slice(0, 4).map((entry) => entry || 'rgba(255,255,255,0.25)')
  const step = 100 / bands.length
  const stops = bands.flatMap((entry, index) => [
    `${entry} ${index * step}%`,
    `${entry} ${(index + 1) * step}%`
  ])
  return `linear-gradient(135deg, ${stops.join(', ')})`
}

/** The "Change type" options for session-ADDED part volumes (never normal parts). */

/**
 * Per-part "Change type" menu (BambuStudio's right-click → Change type): pick the part's
 * Bambu volume subtype. A non-normal part shows a highlighted trigger so retyped parts are
 * visible at a glance in the list. Added part volumes pass the reduced option list
 * (they can never become normal parts).
 */
/**
 * Row marker for a helper volume (support blocker/enforcer, negative part, modifier), in the
 * subtype's viewport colour so the sidebar reads the same as the 3D scene. Stands where a printed
 * part shows nothing: a coloured chip leading the row means "this volume is not printed geometry".
 *
 * Shared by the saved-part rows and the session-added-part rows below them so a blocker looks
 * identical before and after the save that turns it into a real `<component>`.
 */
function HelperVolumeSwatch({ subtype }: { subtype: SceneEditHelperVolumeSubtype }) {
  const spec = HELPER_VOLUME_SPECS[subtype]
  return (
    <Tooltip title={`${spec.label}: ${spec.hint}`}>
      <Box
        sx={{
          width: 12,
          height: 12,
          borderRadius: '3px',
          flexShrink: 0,
          bgcolor: helperVolumeCssColor(spec.color)
        }}
      />
    </Tooltip>
  )
}

function PartTypeMenu({
  subtype,
  partName,
  options = PART_SUBTYPE_OPTIONS,
  onChange
}: {
  subtype: string | null
  partName: string
  options?: ReadonlyArray<{ subtype: SceneEditPartSubtype; label: string }>
  onChange: (subtype: SceneEditPartSubtype) => void
}) {
  // Canonicalize: a 3MF may spell the type `ParameterModifier` (older `volume_type` metadata)
  // rather than `modifier_part`, and a raw compare would leave the menu showing "Normal part".
  const current = canonicalThreeMfPartSubtype(subtype)
  const isSpecial = current !== 'normal_part'
  const currentLabel = options.find((option) => option.subtype === current)?.label ?? current
  return (
    <Dropdown>
      <Tooltip title={`Part type: ${currentLabel}`}>
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{ root: {
            size: 'sm',
            variant: isSpecial ? 'soft' : 'plain',
            color: isSpecial ? 'primary' : 'neutral',
            'aria-label': `Change type of ${partName}`
          } }}
        >
          <CategoryRoundedIcon fontSize="small" />
        </MenuButton>
      </Tooltip>
      <Menu placement="bottom-end" sx={{ zIndex: EDITOR_POPUP_Z_INDEX }}>
        {options.map((option) => (
          <MenuItem
            key={option.subtype}
            selected={option.subtype === current}
            onClick={() => { if (option.subtype !== current) onChange(option.subtype) }}
          >
            {option.label}
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  )
}

/**
 * The row's "more actions" button: opens the SAME context menu the right-click does, anchored on
 * itself.
 *
 * Every row carries one because right-click is not reachable on touch, and these rows are reorder
 * handles -- a long press starts a drag (`useListReorderDrag`, hold-to-drag), and the tile even
 * suppresses the iOS callout so the two cannot both work. Without a button, every action behind
 * the menu (change type, change material, part settings, delete, export) was mouse-only. Deleting
 * a session-added volume was the visible case: it briefly had a trash icon no other row had, which
 * is the divergence this replaces.
 */
function RowMenuButton({ label, onOpen }: {
  label: string
  onOpen: (position: ContextMenuAnchor) => void
}) {
  return (
    <Tooltip title="More actions">
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label={label}
        // The menu it opens is the shared cursor-anchored one (a bare `Menu`, not a Joy
        // `Dropdown`), so the popup semantics Dropdown would supply are not here to inherit.
        // Announce at least that this button opens a menu; the plate strip's kebab gets this from
        // its `MenuButton` and these rows cannot without restructuring the shared menu.
        aria-haspopup="menu"
        // Stop pointerdown as well as click, matching the plate strip's kebab and the contract
        // stated in `hooks/useListReorderDrag.ts`. Today the reorder drag is armed from the row's
        // NAME, a sibling, so nothing here could reach it; the guard is for the obvious future
        // change of moving that handler up to the row, which would silently arm a drag from this
        // button and leave the menu opening mid-gesture.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          // The row itself selects on click; opening the menu must not also re-select or, on a
          // part row, drill the selection somewhere else under the user.
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          onOpen({ x: rect.right, y: rect.bottom, align: 'end' })
        }}
      >
        <MoreVertRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  )
}

/**
 * The slice-config half of a row's controls.
 *
 * Named and exported because it is passed as ONE object and `ObjectList` is memoised: the caller has
 * to build it in a `useMemo`, and an anonymous inline type cannot be annotated there.
 */
export interface ObjectListPerObject {
  sliceObjectIds: Set<number>
  overrideCountFor: (objectId: number) => number
  onEditObject: (objectId: number, name: string) => void
  /** Open per-PART process settings for one part of an object (separate from the object's). */
  onEditPart?: (objectId: number, partIndex: number, name: string) => void
  partOverrideCountFor?: (objectId: number, partIndex: number) => number
}

/**
 * The Objects sidebar list. Each row selects/duplicates/deletes the object. When
 * `perObject` is supplied (slice settings present), the row also carries the
 * per-object controls that used to live in a separate dialog: a print on/off
 * toggle and an override editor (with a badge for the override count).
 *
 * **Memoised, and by far the most expensive thing the editor renders.** Measured with a 166-row
 * sidebar, it is ~82% of the render cost of a single keystroke in the Text tool: every row carries
 * Joy `Tooltip`/`IconButton`/`Dropdown` furniture, so an unrelated edit re-rendering the list costs
 * ~430ms of the ~525ms commit. The memo only works while every prop is stable -- build object and
 * callback props with `useMemo`/`useCallback` at the call site, never inline in JSX.
 */
/**
 * A comparable summary of what an instance's added parts render as.
 *
 * Cheap per row and recomputed on every list render, which is the point: it is the only thing that
 * changes when a part is edited in place, so it is what lets a memoised row notice.
 */
function addedPartsSignature(parts: readonly EditorAddedPart[]): string {
  if (parts.length === 0) return ''
  // The SETTINGS COUNT is in here because the row shows it. Overrides are written by mutating the
  // volume in place (`part.settings = ...`), so without it the memo saw identical props and the
  // badge only appeared once some unrelated prop moved -- deselecting the row, in practice, which
  // made a saved change look like it had not been saved.
  return parts.map((part) => `${part.key}:${part.subtype}:${part.filamentId ?? ''}:${part.name}`
    + `:${Object.keys(part.settings ?? {}).length}`).join('|')
}

/** The shared empty list, so a part-less row's props stay referentially stable. */
const NO_ADDED_PART_ROWS: readonly EditorAddedPart[] = Object.freeze([])

/**
 * One object's rows: the object itself, its parts, and any volumes added this session.
 *
 * Selection and drag arrive ALREADY RESOLVED to this row (booleans and indexes, never the editor's
 * global selection), which is what lets the memo below do anything: selecting something changes
 * props on the one or two rows whose appearance differs, and every other row bails out.
 *
 * Every prop must therefore be a primitive or a STABLE reference. That is a contract on the caller,
 * not a detail: `effectiveAddedParts` returning one frozen empty array rather than a fresh `[]` is
 * part of it, and so is `EditorView` handing over memoised callbacks.
 */
interface ObjectListRowProps {
  instance: EditorInstance
  /** This row is the primary selection; `extraSelected` is a Ctrl/Cmd-click member. */
  primarySelected: boolean
  extraSelected: boolean
  /**
   * The selected parts' member KEYS, ONLY when the selection belongs to this object.
   *
   * Keys rather than the members themselves, and pre-resolved to this row by the list, because this
   * component is memoised on a shallow prop compare: a fresh array of member objects per render
   * would fail that compare for every row on the plate. One string per selected part is comparable
   * by the row's own `arePropsEqual`, and it covers both kinds, so a volume highlights by exactly
   * the rule a baked part does.
   */
  selectedPartKeys: ReadonlyArray<string> | null
  addedParts: readonly EditorAddedPart[]
  /**
   * Whether the object's own geometry gets a row (BambuStudio's "a row per volume once there are
   * two" rule). Resolved by the list, so the row stays a pure prop the memo can compare.
   */
  bodyRow: boolean
  /** The body row's current subtype, so its type menu reads back what was picked. */
  bodySubtype: SceneEditPartSubtype | null
  /**
   * What this row's added parts LOOK like, as a value the memo can compare.
   *
   * Added parts are mutated IN PLACE behind a ref (`handleChangeAddedPartFilament` assigns
   * `part.filamentId` directly), so the array reference is unchanged by an edit and a shallow prop
   * compare sees nothing. Without this the 3D view updated -- it rebuilds meshes directly -- while
   * the row kept showing the old material, which is the exact failure this signature exists to stop.
   */
  addedPartsSignature: string
  /** Drag state, pre-resolved: passing the raw drag would re-render every row on every frame. */
  objectDragging: boolean
  draggingPartIndex: number | null
  perObject?: ObjectListPerObject
  /**
   * The colour table and id resolver, NOT the two closures the list derives from them: those are
   * rebuilt on every list render, so passing them would fail the memo for every row.
   */
  filamentColors?: Record<number, string>
  resolveFilamentId?: (id: number | null) => number | null
  filamentOptions?: FilamentOption[]
  /**
   * How many instances share this one's object, RESOLVED by the list.
   *
   * A number, not the counter: `ObjectListRow` is memoised on shallow prop equality, and the
   * counter is a stable `useCallback` reading a ref, so a row whose linkage changed compared equal
   * and kept a stale badge (fill-bed left the template row unbadged; make-independent left the
   * ex-partners reading `xN`). Same reason `addedPartsSignature` exists.
   */
  linkedCount?: number
  onSelect: (key: string, modifiers?: { additive?: boolean; range?: boolean }) => void
  onSelectPart?: (objectId: number, member: PartMember, modifiers: { additive: boolean; range: boolean }, instanceKey: string) => void
  onObjectContextMenu?: (key: string, position: ContextMenuAnchor) => void
  onPartContextMenu?: (objectId: number, member: PartMember, position: ContextMenuAnchor, instanceKey: string) => void
  onReassignFilament?: (targets: Array<{ objectId: number; partIndex: number }>, filamentId: number) => void
  onReassignInstanceFilament?: (key: string, filamentId: number) => void
  onTogglePrintable: (key: string) => void
  onChangePartType?: (objectId: number, partIndex: number, subtype: SceneEditPartSubtype) => void
  onSelectAddedPart?: (objectId: number, partKey: string, modifiers: { additive: boolean; range: boolean }, instanceKey: string) => void
  onChangeAddedPartType?: (partKeys: ReadonlyArray<string>, subtype: SceneEditPartSubtype) => void
  onChangeAddedPartFilament?: (partKeys: ReadonlyArray<string>, filamentId: number) => void
  onEditAddedPartSettings?: (objectId: number, partKey: string) => void
  onAddedPartContextMenu?: (objectId: number, partKey: string, position: ContextMenuAnchor, instanceKey: string) => void
  onReorderObject?: (hostId: number, beforeHostId: number | null) => void
  onReorderPart?: (hostId: number, partIndex: number, beforePartIndex: number | null) => void
  setTileElement: (group: string, itemIndex: number, element: HTMLElement | null) => void
  handleTilePointerDown: (group: string, itemIndex: number, event: React.PointerEvent) => void
  /** Suppresses the click that ends a reorder drag, so dropping a row does not also select it. */
  shouldSuppressClick: () => boolean
}

const ObjectListRow = memo(function ObjectListRow({
  instance,
  primarySelected,
  extraSelected,
  selectedPartKeys,
  addedParts,
  bodyRow,
  bodySubtype,
  objectDragging,
  draggingPartIndex,
  perObject,
  filamentColors,
  resolveFilamentId,
  filamentOptions,
  linkedCount,
  onSelect,
  onSelectPart,
  onObjectContextMenu,
  onPartContextMenu,
  onReassignFilament,
  onReassignInstanceFilament,
  onTogglePrintable,
  onChangePartType,
  onSelectAddedPart,
  onChangeAddedPartType,
  onChangeAddedPartFilament,
  onEditAddedPartSettings,
  onAddedPartContextMenu,
  onReorderObject,
  onReorderPart,
  setTileElement,
  handleTilePointerDown,
  shouldSuppressClick
}: ObjectListRowProps) {
  const resolveId = resolveFilamentId ?? ((id: number | null) => id)
  const liveColor = (filamentId: number | null, fallback: string | null): string | null =>
    (filamentId != null && filamentColors?.[filamentId]) || fallback || null
        // The object this row places. Every row of an object registers under it, and the hook
        // measures their union, so an object spanning several rows gets one extent.
        const objectHostId = addedPartHostId(instance)
        // The object identity used for per-object settings AND per-part filament reassignment:
        // an in-project object's Bambu id, or an import's stable identity (synthetic for a fresh
        // import, the replaced object's id for "Replace with…"), so a not-yet-saved import's
        // parts are reassignable and its process is editable without a save first.
        const perObjectId = instance.source.kind === 'object'
          ? instance.objectId
          : (instance.source.replacedObjectId ?? null)
        const sliceObject = perObjectId != null && perObject?.sliceObjectIds.has(perObjectId) ? perObjectId : null
        // Printability is an editor-owned per-instance flag (BambuStudio's "Printable"),
        // so the toggle shows for every object on the plate, including just-moved ones,
        // independent of the slice dialog's per-plate object selection.
        const printing = instance.printable
        const overrideCount = sliceObject != null ? perObject!.overrideCountFor(sliceObject) : 0
        // Objects can hold multiple volumes, each on its own filament: list them nested. Counted
        // over EVERY volume (baked parts, session-added ones, and the body where the part list does
        // not describe it), never over `instance.parts` alone: see `instanceVolumeRows`.
        const { showRows: showParts, cutConnectorCount } = instanceVolumeRows(instance, addedParts.length)
        // The group this row's part rows drag in, or null when this row has no reorderable parts.
        // Gated on the BAKED count on purpose, unlike the row rule above: `SceneEdit.partOrder` is a
        // list of base ordinals, which a session-added volume has no member of, so only baked parts
        // can currently reorder. Registering a one-part group would give a row a drag handle that
        // can only drop where it already is.
        const partDragHost = onReorderPart && instance.parts.length > 1 && addedPartHostId(instance) != null ? instance.key : null
        // The object-level badge summarises every PRINTED volume it owns -- baked parts, the volumes
        // added this session, and its own body where the part list does not describe it: one
        // material when they agree (shown like any single-material row), otherwise the
        // indeterminate mixed swatch. Helper volumes are excluded from both the summary and the
        // reassignment behind it: see instanceMaterialVolumes().
        const partMaterial = summarizeInstanceMaterial(instance, resolveId, liveColor, addedParts)
        // Null while the volumes disagree, which is what makes the badge render its mixed bands.
        const materialColor = partMaterial.mixedColors
          ? null
          : liveColor(partMaterial.uniformId, partMaterial.uniformColor)
        return (
          <Fragment>
            <ListItem
              ref={onReorderObject && objectHostId != null
                ? (element: HTMLElement | null) => setTileElement(OBJECT_LIST_GROUP, objectHostId, element)
                : undefined}
              onContextMenu={onObjectContextMenu ? (event) => {
                event.preventDefault()
                onObjectContextMenu(instance.key, { x: event.clientX, y: event.clientY })
              } : undefined}
              sx={{
                borderRadius: 'sm',
                bgcolor: primarySelected ? 'neutral.softBg' : extraSelected ? 'neutral.plainActiveBg' : undefined,
                // Every row of the dragged OBJECT dims, not just the one under the pointer, so a
                // linked copy shows that it travels with its original.
                ...(objectDragging ? { opacity: 0.4 } : {})
              }}
            >
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
                <Tooltip title={printing ? 'Printable, toggle to skip' : 'Skipped, toggle to print'} variant="soft">
                  <Switch
                    size="sm"
                    checked={printing}
                    onChange={() => onTogglePrintable(instance.key)}
                    slotProps={{ input: { 'aria-label': `Print ${instance.name}` } }}
                    sx={{ flexShrink: 0 }}
                  />
                </Tooltip>
                <Typography
                  level="body-sm"
                  noWrap
                  // The NAME is the drag handle, not the whole row: a row carries a printable
                  // switch, a material swatch, a settings button and a kebab, each with its own
                  // pointer behaviour, and arming a drag from the row would fight all four.
                  onPointerDown={onReorderObject && objectHostId != null
                    ? (event) => handleTilePointerDown(OBJECT_LIST_GROUP, objectHostId, event)
                    : undefined}
                  onClick={(event) => {
                    // A completed drop synthesizes a click here; selecting on it would change the
                    // selection as a side effect of reordering.
                    if (shouldSuppressClick()) return
                    onSelect(instance.key, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey })
                  }}
                  // userSelect off so a Shift-range click extends the selection instead of
                  // highlighting the row names as text.
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    cursor: 'pointer',
                    userSelect: 'none',
                    opacity: printing ? 1 : 0.5,
                    // Without this a touch drag scrolls the sidebar instead of moving the row.
                    ...(onReorderObject ? { touchAction: 'none' } : {})
                  }}
                >
                  {instance.name}
                </Typography>
                {linkedCount != null && linkedCount > 1 && (
                  // Linkage is otherwise invisible: users discover it by editing one copy and
                  // watching another change. BambuStudio has the same ambiguity; we name it.
                  <Tooltip title={`Linked copy: ${linkedCount} instances share this object's parts, materials, paint and settings. Right-click to make one independent.`}>
                    <Chip size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>
                      x{linkedCount}
                    </Chip>
                  </Tooltip>
                )}
                {/*
                  * ONE badge, whatever shape the object is. An object row's material is changeable
                  * whenever the row HAS one, which is not the same as having parts: a model with no
                  * parts list -- a primitive, a single-solid import, a single-mesh object in a saved
                  * project -- keeps its material on the instance. This used to be three branches
                  * keyed off `parts.length`, and the middle one rendered NOTHING for an object whose
                  * volumes are all session-added, which is every primitive the moment a part is
                  * dropped on it. `summarizeInstanceMaterial` now answers for every shape and
                  * `onReassignInstanceFilament` writes back to whichever home the material lives in.
                  */}
                {onReassignInstanceFilament ? (
                  <FilamentBadge
                    filamentId={partMaterial.uniformId}
                    color={materialColor}
                    mixedColors={partMaterial.mixedColors}
                    options={filamentOptions}
                    title={showParts
                      ? (partMaterial.mixedColors ? "Mixed materials: set all parts' material" : "Set all parts' material")
                      : 'Change material'}
                    onReassign={(fid) => onReassignInstanceFilament(instance.key, fid)}
                  />
                ) : (
                  <FilamentBadge
                    filamentId={partMaterial.uniformId}
                    color={materialColor}
                    mixedColors={partMaterial.mixedColors}
                    options={filamentOptions}
                  />
                )}
                {perObject && sliceObject != null && (
                  <SettingsTuneButton
                    changedCount={overrideCount}
                    title="Per-object settings"
                    ariaLabel={`Per-object settings for ${instance.name}`}
                    onClick={() => perObject.onEditObject(sliceObject, instance.name)}
                  />
                )}
                {onObjectContextMenu && (
                  <RowMenuButton
                    label={`More actions for ${instance.name}`}
                    onOpen={(position) => onObjectContextMenu(instance.key, position)}
                  />
                )}
              </Stack>
            </ListItem>
            {/* The object's OWN geometry, as a row, for an object whose part list does not
                describe it. BambuStudio's rule: a row per volume once there are two, none at one --
                so this appears exactly when a part has been added beside the body. Without it the
                body has nothing to click, and the object row was the only thing standing in for it.
                It carries the object's name because that is the only name the body has. */}
            {bodyRow && perObjectId != null && (
              <ListItem
                sx={{
                  pl: 3,
                  borderRadius: 'sm',
                  bgcolor: selectedPartKeys?.includes(partMemberKey({ kind: 'body' })) ? 'neutral.softBg' : undefined,
                  ...(objectDragging ? { opacity: 0.4 } : {})
                }}
              >
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%', minWidth: 0, opacity: printing ? 0.85 : 0.4 }}>
                  {/* The subtype chip a baked part row leads with, on the same rule: a retyped body
                      is a helper volume and must read as one here too, exactly as it will once a
                      save has promoted it to a real `<part>`. */}
                  {bodySubtype && bodySubtype !== 'normal_part' && <HelperVolumeSwatch subtype={bodySubtype} />}
                  <Typography
                    level="body-xs"
                    noWrap
                    onClick={onSelectPart ? (event: ReactMouseEvent) => {
                      if (shouldSuppressClick()) return
                      onSelectPart(perObjectId, { kind: 'body' },
                        { additive: event.ctrlKey || event.metaKey, range: event.shiftKey }, instance.key)
                    } : undefined}
                    sx={{ flex: 1, minWidth: 0, ...(onSelectPart ? { cursor: 'pointer', userSelect: 'none' } : {}) }}
                  >
                    {/* The object's OWN name, with no suffix. A save promotes this body to a real
                        `<part>` carrying exactly that name, so anything added here (it read
                        "<name> (body)") existed pre-save and vanished post-save -- the save boundary
                        showing through in the one place the user reads first. The duplicate text one
                        indent apart is what BambuStudio shows too, and is what the file will say. */}
                    {instance.name}
                  </Typography>
                  {/* The body's material IS the object's -- the second of the two homes a material
                      lives in -- so this row carries the same badge every other volume row does,
                      writing through the instance. Without it the body was the one volume row with
                      no material control, and it grew one on the next save. */}
                  {onReassignInstanceFilament && (
                    <FilamentBadge
                      filamentId={resolveId(instance.filamentId)}
                      color={liveColor(resolveId(instance.filamentId), instance.color)}
                      options={filamentOptions}
                      title="Change material"
                      onReassign={(fid) => onReassignInstanceFilament(instance.key, fid)}
                    />
                  )}
                  {/* The SAME controls a baked part row carries, because a save turns this row into
                      one: its type and its per-part settings both address ordinal 0 of the object,
                      which is where the bake's promotion puts the body (`applyAddedParts` moves the
                      inline mesh into component 0 and re-keys the host's own `<part>` entry onto it,
                      BEFORE every part-scoped applier runs). Missing, they appeared out of nowhere
                      on the next save. */}
                  {onChangePartType && (
                    <PartTypeMenu
                      subtype={bodySubtype ?? 'normal_part'}
                      partName={instance.name}
                      onChange={(subtype) => onChangePartType(perObjectId, BODY_PART_INDEX, subtype)}
                    />
                  )}
                  {perObject?.onEditPart && (() => {
                    const bodyOverrides = perObject.partOverrideCountFor?.(perObjectId, BODY_PART_INDEX) ?? 0
                    return (
                      <SettingsTuneButton
                        changedCount={bodyOverrides}
                        title="Part settings"
                        ariaLabel={`Part settings for ${instance.name}`}
                        onClick={() => perObject.onEditPart!(perObjectId, BODY_PART_INDEX, instance.name)}
                      />
                    )
                  })()}
                  {onPartContextMenu && (
                    <RowMenuButton
                      label={`More actions for ${instance.name}`}
                      onOpen={(position) => onPartContextMenu(perObjectId, { kind: 'body' }, position, instance.key)}
                    />
                  )}
                </Stack>
              </ListItem>
            )}
            {/* One row for the whole set, never a row each, and shown whether or not the object
                has volume rows -- BambuStudio adds its info item on `is_cut() && has_connectors()`
                alone (`GUI_ObjectList.cpp:4235`), so a half whose only extra volume is a peg still
                says so while listing no parts. */}
            {cutConnectorCount > 0 && (
              <ListItem sx={{ pl: 4 }}>
                <Typography
                  level="body-xs"
                  startDecorator={<ContentCutRoundedIcon fontSize="small" />}
                  sx={{ color: 'text.tertiary' }}
                >
                  {cutConnectorCount === 1 ? 'Cut connector' : `Cut connectors (${cutConnectorCount})`}
                </Typography>
              </ListItem>
            )}
            {showParts && instance.parts.filter((part) => !part.cutConnector).map((part) => {
              // Both halves already resolved to THIS object by the list, so a selection landing on
              // another object leaves this row's props untouched and the row does not re-render.
              const partSelected = selectedPartKeys?.includes(partMemberKey({ kind: 'baked', partIndex: part.partIndex })) ?? false
              // BambuStudio draws the extruder swatch for normal parts and modifiers only: a
              // blocker/enforcer/negative volume has no material to show, so its row leads with
              // the subtype chip instead, the same marker the session-added rows below use.
              const partSubtype = canonicalThreeMfPartSubtype(part.subtype)
              const helperSubtype = partSubtype === 'normal_part' ? null : partSubtype
              const partCarriesFilament = threeMfPartSubtypeCarriesFilament(partSubtype)
              // An unassigned part prints in the OBJECT's material, so resolve through the same
              // inheritance the bake applies rather than letting the null fall through
              // `resolveId`'s dangling-id fallback to the project's first material.
              const partFilamentId = resolveId(effectivePartFilamentId(part, instance.filamentId))
              return (
              <ListItem
                // Keyed by the part's own ORDINAL, not its position: an index key remounts every
                // row of a reordered object, which makes the list flicker mid-drag.
                key={`${instance.key}:part:${part.partIndex}`}
                ref={(element: HTMLElement | null) => {
                  // Registered in BOTH groups: under its own ordinal for the part drag, and under
                  // its object for the object drag, so the object's extent covers its part rows and
                  // the caret lands on the object's boundary rather than inside its body.
                  if (partDragHost != null) setTileElement(partListGroup(partDragHost), part.partIndex, element)
                  if (onReorderObject && objectHostId != null) setTileElement(OBJECT_LIST_GROUP, objectHostId, element)
                }}
                onContextMenu={onPartContextMenu && perObjectId != null ? (event) => {
                  event.preventDefault()
                  onPartContextMenu(perObjectId, { kind: 'baked', partIndex: part.partIndex }, { x: event.clientX, y: event.clientY }, instance.key)
                } : undefined}
                sx={{
                  pl: 3,
                  borderRadius: 'sm',
                  bgcolor: partSelected ? 'neutral.softBg' : undefined,
                  // Dimmed while its OWN row is being dragged, and while its OBJECT is: every row of
                  // the dragged object dims (see the object row), and leaving the baked part rows
                  // lit split the object in half visually mid-drag.
                  ...(draggingPartIndex === part.partIndex || objectDragging
                    ? { opacity: 0.4 }
                    : {})
                }}
              >
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%', minWidth: 0, opacity: printing ? 0.85 : 0.4 }}>
                  {helperSubtype && <HelperVolumeSwatch subtype={helperSubtype} />}
                  <Typography
                    level="body-xs"
                    noWrap
                    // The name is the drag handle here too; the row's swatch, type menu, settings
                    // button and kebab keep their own pointer behaviour.
                    onPointerDown={partDragHost != null
                      ? (event) => handleTilePointerDown(partListGroup(partDragHost), part.partIndex, event)
                      : undefined}
                    onClick={onSelectPart && perObjectId != null ? (event) => {
                      if (shouldSuppressClick()) return
                      onSelectPart(perObjectId, { kind: 'baked', partIndex: part.partIndex },
                        { additive: event.ctrlKey || event.metaKey, range: event.shiftKey }, instance.key)
                    } : undefined}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      ...(onSelectPart && perObjectId != null ? { cursor: 'pointer', userSelect: 'none' } : {}),
                      ...(partDragHost != null ? { touchAction: 'none' } : {})
                    }}
                  >
                    {part.name ?? `Part ${part.partIndex + 1}`}
                  </Typography>
                  {partCarriesFilament && (
                    <FilamentBadge
                      filamentId={partFilamentId}
                      color={liveColor(partFilamentId, part.color)}
                      options={filamentOptions}
                      title={helperSubtype ? 'Material printed inside this modifier' : undefined}
                      onReassign={onReassignFilament && perObjectId != null ? (fid) => onReassignFilament([{ objectId: perObjectId, partIndex: part.partIndex }], fid) : undefined}
                    />
                  )}
                  {onChangePartType && perObjectId != null && (
                    <PartTypeMenu
                      subtype={partSubtype}
                      partName={part.name ?? `Part ${part.partIndex + 1}`}
                      onChange={(subtype) => onChangePartType(perObjectId, part.partIndex, subtype)}
                    />
                  )}
                  {perObject?.onEditPart && perObjectId != null && (() => {
                    const partOverrides = perObject!.partOverrideCountFor?.(perObjectId, part.partIndex) ?? 0
                    return (
                      // Addressed by the object's own editor-side id, NOT by `sliceObject`: that is
                      // membership of the BAKED slice index, which is trap #3 of the no-save rule in
                      // this plugin'the s development notes, and the session-added row beside it never consulted
                      // it -- so an object outside that set lost its baked parts' settings buttons
                      // while keeping them on its volumes. The dialog resolves the owner by host id
                      // either way, so the set was never load-bearing here.
                      <SettingsTuneButton
                        changedCount={partOverrides}
                        title="Part settings"
                        ariaLabel={`Part settings for ${part.name ?? `Part ${part.partIndex + 1}`}`}
                        onClick={() => perObject!.onEditPart!(perObjectId, part.partIndex, part.name ?? `Part ${part.partIndex + 1}`)}
                      />
                    )
                  })()}
                  {onPartContextMenu && perObjectId != null && (
                    <RowMenuButton
                      label={`More actions for ${part.name ?? `Part ${part.partIndex + 1}`}`}
                      onOpen={(position) => onPartContextMenu(perObjectId, { kind: 'baked', partIndex: part.partIndex }, position, instance.key)}
                    />
                  )}
                </Stack>
              </ListItem>
              )
            })}
            {addedParts.map((part) => {
              // Canonicalised first, exactly as the baked row does: the raw subtype spelling varies
              // between writers, so comparing a raw one to the enum is what the shared codec exists
              // to stop. Volumes are minted with canonical subtypes today, so this is latent -- but
              // it is the same row in the same list and must not read its type by a different rule.
              const addedSubtype = canonicalThreeMfPartSubtype(part.subtype)
              const addedHelperSubtype = addedSubtype === 'normal_part' ? null : addedSubtype
              return (
              // Part volumes added THIS session (support blocker/enforcer, modifier, negative):
              // they only become real `<component>` parts at save time, so list them from the
              // session state, otherwise a freshly added blocker is invisible here until a
              // save + reopen. Clicking hands the part the transform gizmo.
              <ListItem
                key={part.key}
                onContextMenu={onAddedPartContextMenu && perObjectId != null ? (event) => {
                  event.preventDefault()
                  onAddedPartContextMenu(perObjectId, part.key, { x: event.clientX, y: event.clientY }, instance.key)
                } : undefined}
                // Part of the OBJECT's extent, like the base part rows above: an object's rows must
                // be one contiguous run or the drop caret is drawn inside its own body.
                ref={onReorderObject && objectHostId != null
                  ? (element: HTMLElement | null) => setTileElement(OBJECT_LIST_GROUP, objectHostId, element)
                  : undefined}
                sx={{
                  pl: 3,
                  borderRadius: 'sm',
                  bgcolor: selectedPartKeys?.includes(partMemberKey({ kind: 'added', key: part.key }))
                    ? 'neutral.softBg'
                    : undefined,
                  ...(objectDragging ? { opacity: 0.4 } : {})
                }}
              >
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%', minWidth: 0, opacity: printing ? 0.85 : 0.4 }}>
                  {addedHelperSubtype && <HelperVolumeSwatch subtype={addedHelperSubtype} />}
                  <Typography
                    level="body-xs"
                    noWrap
                    // Ctrl and Shift read here for the first time: this row used to call a handler
                    // that took no modifiers, so a volume could not join a multi-part selection at
                    // all. It is the same handler the baked part rows above call.
                    onClick={onSelectAddedPart && perObjectId != null ? (event: ReactMouseEvent) => {
                      if (shouldSuppressClick()) return
                      onSelectAddedPart(perObjectId, part.key,
                        { additive: event.ctrlKey || event.metaKey, range: event.shiftKey }, instance.key)
                    } : undefined}
                    sx={{ flex: 1, minWidth: 0, ...(onSelectAddedPart && perObjectId != null ? { cursor: 'pointer', userSelect: 'none' } : {}) }}
                  >
                    {part.name}
                  </Typography>
                  {threeMfPartSubtypeCarriesFilament(addedSubtype) && (
                    <FilamentBadge
                      filamentId={resolveId(effectivePartFilamentId(part, instance.filamentId))}
                      color={liveColor(resolveId(effectivePartFilamentId(part, instance.filamentId)), null)}
                      options={filamentOptions}
                      title={addedSubtype === 'modifier_part' ? 'Material printed inside this modifier' : undefined}
                      onReassign={onChangeAddedPartFilament ? (fid) => onChangeAddedPartFilament([part.key], fid) : undefined}
                    />
                  )}
                  {onChangeAddedPartType && (
                    <PartTypeMenu
                      subtype={addedSubtype}
                      partName={part.name}
                      onChange={(subtype) => onChangeAddedPartType([part.key], subtype)}
                    />
                  )}
                  {onEditAddedPartSettings && perObjectId != null && (
                    // The SAME control the baked part rows use. This row used to swap the button's
                    // variant and colour instead of showing the count, so one list had two visual
                    // languages for "this has overrides" and a volume never said how many.
                    <SettingsTuneButton
                      changedCount={Object.keys(part.settings ?? {}).length}
                      title="Part settings"
                      ariaLabel={`Part settings for ${part.name}`}
                      onClick={() => onEditAddedPartSettings(perObjectId, part.key)}
                    />
                  )}
                  {onAddedPartContextMenu && perObjectId != null && (
                    <RowMenuButton
                      label={`More actions for ${part.name}`}
                      onOpen={(position) => onAddedPartContextMenu(perObjectId, part.key, position, instance.key)}
                    />
                  )}
                </Stack>
              </ListItem>
              )
            })}
          </Fragment>
        )
})

export const ObjectList = memo(function ObjectList({
  instances,
  selectedKey,
  extraSelectedKeys,
  partSelection,
  gizmoPart,
  onSelect,
  onSelectPart,
  linkedCopyCountFor,
  onObjectContextMenu,
  onPartContextMenu,
  filamentColors,
  filamentOptions,
  onReassignFilament,
  onReassignInstanceFilament,
  resolveFilamentId,
  onTogglePrintable,
  onChangePartType,
  addedPartsFor,
  bodySubtypeFor,
  onSelectAddedPart,
  onChangeAddedPartType,
  onChangeAddedPartFilament,
  onEditAddedPartSettings,
  onAddedPartContextMenu,
  perObject,
  onReorderObject,
  onReorderPart
}: {
  instances: EditorInstance[]
  selectedKey: string | null
  /** Additional multi-selected instance keys (Ctrl/Cmd-click). */
  extraSelectedKeys?: ReadonlyArray<string>
  /** Selected PARTS of one object (mutually exclusive with the object selection). */
  partSelection?: PartSelection | null
  /** The baked part currently holding the transform gizmo (row highlight). */
  gizmoPart?: PartRef | null
  onSelect: (key: string, modifiers?: { additive?: boolean; range?: boolean }) => void
  /**
   * Select a part row: plain click hands the part the gizmo (move/rotate/scale);
   * Ctrl-toggle / Shift-range build the bulk selection (BambuStudio volume-mode rules).
   */
  onSelectPart?: (objectId: number, member: PartMember, modifiers: { additive: boolean; range: boolean }, instanceKey: string) => void
  /**
   * How many placed instances share this one's object. >1 shows the linked-copy badge, which is
   * the only place the editor tells the user that editing this object also edits its copies.
   */
  linkedCopyCountFor?: (instanceKey: string) => number
  /** Right-click on an object row: open the object context menu at the pointer. */
  onObjectContextMenu?: (key: string, position: ContextMenuAnchor) => void
  /** Right-click on a part row: open the part context menu at the pointer. */
  onPartContextMenu?: (objectId: number, member: PartMember, position: ContextMenuAnchor, instanceKey: string) => void
  filamentColors?: Record<number, string>
  filamentOptions?: FilamentOption[]
  onReassignFilament?: (targets: Array<{ objectId: number; partIndex: number }>, filamentId: number) => void
  /**
   * Set a whole object's material, addressed by INSTANCE key rather than by object id + part.
   * Separate from `onReassignFilament` because a model with no parts list has no part to name, and
   * its material lives on the instance -- see the note at the object row's badge.
   */
  onReassignInstanceFilament?: (key: string, filamentId: number) => void
  /** Map a (possibly-removed) material id to the one shown (removed -> material 1). */
  resolveFilamentId?: (id: number | null) => number | null
  /** Toggle an instance's Bambu "Printable" flag (per-instance, editor-owned). */
  onTogglePrintable: (key: string) => void
  /** Change a part's Bambu volume type (BambuStudio's "Change type"), keyed like part filament. */
  onChangePartType?: (objectId: number, partIndex: number, subtype: SceneEditPartSubtype) => void
  /** Part volumes ADDED this session (blockers/enforcers/modifiers/negatives) for an instance's object. */
  addedPartsFor?: (instance: EditorInstance) => readonly EditorAddedPart[]
  /**
   * The subtype an object's BODY row shows. Read through a callback like `addedPartsFor` because it
   * lives in session state rather than on the instance, and must stay a STABLE reference: this list
   * is memoised and an inline arrow re-renders every row.
   */
  bodySubtypeFor?: (instance: EditorInstance) => SceneEditPartSubtype
  /** The added part currently holding the transform gizmo (row highlight). */
  /** Select an added part row: selects the instance and hands the part the gizmo. */
  onSelectAddedPart?: (objectId: number, partKey: string, modifiers: { additive: boolean; range: boolean }, instanceKey: string) => void
  onChangeAddedPartType?: (partKeys: ReadonlyArray<string>, subtype: SceneEditPartSubtype) => void
  /** Reassign an added part's material. Only offered for subtypes that carry one. */
  onChangeAddedPartFilament?: (partKeys: ReadonlyArray<string>, filamentId: number) => void
  /** Open per-volume process settings for a modifier part (needs slice settings). */
  onEditAddedPartSettings?: (objectId: number, partKey: string) => void
  /** Right-click a session-added volume: same actions as a baked part, keyed by the part's key. */
  onAddedPartContextMenu?: (objectId: number, partKey: string, position: ContextMenuAnchor, instanceKey: string) => void
  /** Slice-config per-object process overrides (keyed by Bambu objectId). Null without a profile. */
  perObject?: ObjectListPerObject
  /**
   * Move `hostId`'s object to sit immediately before `beforeHostId`, or last when that is null.
   *
   * Reported as a pair of `addedPartHostId`s, the same identity every per-object and per-part
   * callback here uses, rather than as positions: this list renders only the instances whose
   * geometry is ready, so its positions are a subset of the plate's while a project loads. Absent
   * on a host that does not support reordering.
   */
  onReorderObject?: (hostId: number, beforeHostId: number | null) => void
  /**
   * Move the part at BASE ordinal `partIndex` inside `hostId`'s object to sit immediately before
   * `beforePartIndex`, or last when that is null. Ordinals, never row positions, matching every
   * other part-scoped callback here. Absent on a host that does not support reordering.
   */
  onReorderPart?: (hostId: number, partIndex: number, beforePartIndex: number | null) => void
}) {
  /**
   * The drag groups, plus what each part group hosts.
   *
   * The object group's item indices are HOST IDS, not positions: they are what the drop reports, so
   * `insertAt` reads the anchor straight out of `itemIndices` with no second list to keep in step.
   * A part group is scoped to the ROW its parts render under, not to the object, because a linked
   * copy renders the same object's parts a second time; the drop reaches the object either way,
   * since part order is geometry-level.
   */
  const { dragGroups, partGroupHosts } = useMemo(() => {
    const objectIds: number[] = []
    const seen = new Set<number>()
    for (const instance of instances) {
      const hostId = addedPartHostId(instance)
      if (hostId == null || seen.has(hostId)) continue
      seen.add(hostId)
      objectIds.push(hostId)
    }
    const groups: ListReorderGroup[] = [{ key: OBJECT_LIST_GROUP, itemIndices: objectIds }]
    const hosts = new Map<string, number>()
    if (onReorderPart) {
      for (const instance of instances) {
        const hostId = addedPartHostId(instance)
        if (hostId == null || instance.parts.length < 2) continue
        const key = partListGroup(instance.key)
        hosts.set(key, hostId)
        groups.push({ key, itemIndices: instance.parts.map((part) => part.partIndex) })
      }
    }
    return { dragGroups: groups, partGroupHosts: hosts }
  }, [instances, onReorderPart])
  const { drag, setContainerElement, setCaretElement, setTileElement, handleTilePointerDown, shouldSuppressClick } = useListReorderDrag({
    vertical: true,
    groups: dragGroups,
    onDrop: (group, from, insertAt, before) => {
      // The hook resolves the insertion GAP to the item currently at it (null past the end), so
      // both movers get "put this one before that one". Naming the anchor rather than counting to
      // it is what makes the drag direction irrelevant: the moved entry vacating its own slot
      // cannot shift an anchor identified by id.
      if (group === OBJECT_LIST_GROUP) {
        onReorderObject?.(from, before)
        return
      }
      const hostId = partGroupHosts.get(group)
      if (hostId != null) onReorderPart?.(hostId, from, before)
    }
  })
  // The selected parts as member keys, computed ONCE for the whole list rather than per row: the
  // rows are memoised on a shallow prop compare, so a fresh array per row would fail that compare
  // for every object on the plate. Falls back to the single gizmo'd part, which highlights its row
  // exactly as a member of a bulk set does.
  const selectedPartsObjectId = partSelection?.objectId ?? gizmoPart?.objectId ?? null
  const selectedPartKeys = useMemo(
    () => (partSelection?.members ?? (gizmoPart ? [gizmoPart.member] : [])).map(partMemberKey),
    [partSelection, gizmoPart]
  )
  return (
    <List
      size="sm"
      // Either drag needs the container: `measure` returns null without it, which would leave a
      // host that supplies only one of the two callbacks with a silently dead drag.
      ref={onReorderObject || onReorderPart ? setContainerElement : undefined}
      sx={{ '--ListItem-minHeight': '2.5rem', position: 'relative' }}
    >
      {instances.map((instance) => {
        const objectHostId = addedPartHostId(instance)
        const perObjectId = instance.source.kind === 'object'
          ? instance.objectId
          : (instance.source.replacedObjectId ?? null)
        const addedParts = addedPartsFor?.(instance) ?? NO_ADDED_PART_ROWS
        const partDragHost = onReorderPart && instance.parts.length > 1 && objectHostId != null ? instance.key : null
        // Resolve selection and drag to THIS row here, so the memo sees stable props for every row
        // the change does not touch. Passing the editor's own selection down instead re-renders all
        // of them, which is the cost this exists to remove.
        return (
          <ObjectListRow
            key={instance.key}
            instance={instance}
            // A part of this object holding the gizmo does NOT make the object row look selected.
            // The object genuinely stays selected underneath -- the tool rail goes inert without it,
            // which is why the part path keeps `selectedKey` -- but showing both highlighted read as
            // "the parent is always selected" and made a part impossible to pick out on its own.
            primarySelected={instance.key === selectedKey
              && !(perObjectId != null && perObjectId === selectedPartsObjectId && selectedPartKeys.length > 0)}
            extraSelected={extraSelectedKeys?.includes(instance.key) ?? false}
            selectedPartKeys={perObjectId != null && perObjectId === selectedPartsObjectId ? selectedPartKeys : null}
            bodyRow={instanceVolumeRows(instance, addedParts.length).showBodyRow}
            bodySubtype={bodySubtypeFor?.(instance) ?? null}
            addedParts={addedParts}
            addedPartsSignature={addedPartsSignature(addedParts)}
            objectDragging={drag?.group === OBJECT_LIST_GROUP && drag.itemIndex === objectHostId}
            draggingPartIndex={partDragHost != null && drag?.group === partListGroup(partDragHost) ? drag.itemIndex : null}
            perObject={perObject}
            filamentColors={filamentColors}
            resolveFilamentId={resolveFilamentId}
            filamentOptions={filamentOptions}
            linkedCount={linkedCopyCountFor?.(instance.key) ?? 1}
            onSelect={onSelect}
            onSelectPart={onSelectPart}
            onObjectContextMenu={onObjectContextMenu}
            onPartContextMenu={onPartContextMenu}
            onReassignFilament={onReassignFilament}
            onReassignInstanceFilament={onReassignInstanceFilament}
            onTogglePrintable={onTogglePrintable}
            onChangePartType={onChangePartType}
            onSelectAddedPart={onSelectAddedPart}
            onChangeAddedPartType={onChangeAddedPartType}
            onChangeAddedPartFilament={onChangeAddedPartFilament}
            onEditAddedPartSettings={onEditAddedPartSettings}
            onAddedPartContextMenu={onAddedPartContextMenu}
            onReorderObject={onReorderObject}
            onReorderPart={onReorderPart}
            setTileElement={setTileElement}
            handleTilePointerDown={handleTilePointerDown}
            shouldSuppressClick={shouldSuppressClick}
          />
        )
      })}
      <ListReorderCaret setCaretElement={setCaretElement} />
    </List>
  )
})

