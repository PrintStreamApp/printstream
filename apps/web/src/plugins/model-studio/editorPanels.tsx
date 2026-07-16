/**
 * Leaf presentational sub-components for the 3MF plate editor.
 *
 * These render no editor state of their own beyond trivial local UI state (drag
 * highlight, a focused field's draft string): the plate thumbnail strip, the gizmo
 * toolbar and its buttons, the keyboard-shortcut help popup, the manual transform
 * panel and its axis inputs, the per-plate layer-pauses section, and the filament
 * option row shared by the material
 * pickers. Shared editor types/consts come from ./editorGeometry; the
 * filament-option shape is a type-only import from ./EditorView (erased, no runtime
 * cycle).
 */
import { Fragment, useRef, useState, type ReactNode } from 'react'
import {
  Box,
  Button,
  buttonClasses,
  ButtonGroup,
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
  Option,
  Select,
  Sheet,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/joy'
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import DriveFileRenameOutlineRoundedIcon from '@mui/icons-material/DriveFileRenameOutlineRounded'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import LayersRoundedIcon from '@mui/icons-material/LayersRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded'
import OpenWithRoundedIcon from '@mui/icons-material/OpenWith'
import ThreeSixtyRoundedIcon from '@mui/icons-material/ThreeSixtyRounded'
import AspectRatioRoundedIcon from '@mui/icons-material/AspectRatioRounded'
import VerticalAlignBottomRoundedIcon from '@mui/icons-material/VerticalAlignBottomRounded'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import FlipRoundedIcon from '@mui/icons-material/FlipRounded'
import LockRoundedIcon from '@mui/icons-material/LockRounded'
import LockOpenRoundedIcon from '@mui/icons-material/LockOpenRounded'
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded'
import UnfoldLessRoundedIcon from '@mui/icons-material/UnfoldLessRounded'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'
import AdjustRoundedIcon from '@mui/icons-material/AdjustRounded'
import BrushRoundedIcon from '@mui/icons-material/BrushRounded'
import FormatPaintRoundedIcon from '@mui/icons-material/FormatPaintRounded'
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import TouchAppRoundedIcon from '@mui/icons-material/TouchAppRounded'
import type { LibraryFile, SceneEditAddedPartSubtype, SceneEditPartSubtype } from '@printstream/shared'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { useMobileViewport } from '../../components/useMobileViewport'
import { ADDED_PART_SPECS, PART_SUBTYPE_OPTIONS, type GizmoMode, type SelectedTransform } from './editorGeometry'
import type { EditorAddedPart, EditorFilamentChange, EditorInstance, EditorPause, EditorPlate } from './lib/editorModel'
import { PRIMITIVE_LABELS, type PrimitiveKind } from './lib/primitives'
import type { FilamentOption } from './EditorView'

/** Top offset for the floating tool panels (cut / measure / paint / brim ears) — clears the toolbar. */
export const TOOL_PANEL_TOP = { xs: 52, sm: 56 } as const

/**
 * Plate selector strip: a live thumbnail per plate (rendered offscreen from the
 * edited layout), with add-plate and per-plate delete. The selected plate is
 * highlighted.
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
  onReorderPlate
}: {
  plates: EditorPlate[]
  activeIndex: number
  thumbnails: Record<number, string>
  /** Embedded PNG URL for a plate's source thumbnail, or null when the 3MF has none. */
  embeddedThumbnailUrl: (plateIndex: number) => string | null
  onSelect: (index: number) => void
  onAddPlate: () => void
  onRemovePlate: (index: number) => void
  onRenamePlate: (index: number) => void
  onReorderPlate: (fromIndex: number, toIndex: number) => void
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  // Tile currently hovered during a reorder drag, for the drop-target highlight.
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  // Collapsed mode trades the thumbnails for name-only chips so the 3D viewport gets the
  // vertical space back; the preference sticks across sessions.
  const [collapsed, setCollapsed] = useLocalStorageState(
    'bambu.editor.plateStripCollapsed',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  return (
    <Sheet variant="outlined" sx={{ p: 0.75, borderRadius: 'sm', bgcolor: 'background.level1', width: '100%', minWidth: 0 }}>
    <Stack direction="row" spacing={0.75} sx={{ overflowX: 'auto', alignItems: 'stretch' }}>
      {plates.map((plate) => {
        const active = plate.index === activeIndex
        // Prefer a live client-rendered thumbnail (the active plate + any plate the user has
        // opened/edited reflect the real layout); otherwise fall back to the 3MF's embedded
        // PNG so unopened plates don't have to be loaded + rendered just to fill the strip.
        const liveThumbnail = thumbnails[plate.index]
        const embedded = liveThumbnail ? null : embeddedThumbnailUrl(plate.index)
        const thumbnail = liveThumbnail ?? embedded
        // No live render and no embedded PNG means the plate is genuinely still loading
        // (e.g. a freshly added empty plate before it's opened) — show a spinner.
        const loading = !thumbnail
        const label = plate.name?.trim() || `Plate ${plate.index}`
        return (
          <Sheet
            key={plate.index}
            // A div (not a <button>) because the tile contains the options MenuButton, and a
            // button nested in a button is invalid DOM. role/tabIndex/keydown keep it operable.
            component="div"
            role="button"
            tabIndex={0}
            variant={active ? 'solid' : 'outlined'}
            color={active ? 'primary' : 'neutral'}
            onClick={() => onSelect(plate.index)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(plate.index) }
            }}
            draggable
            onDragStart={(event) => { setDragIndex(plate.index); event.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
            onDragOver={(event) => {
              if (dragIndex === null || dragIndex === plate.index) return
              event.preventDefault()
              setDragOverIndex(plate.index)
            }}
            onDragLeave={() => setDragOverIndex((current) => (current === plate.index ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              if (dragIndex !== null && dragIndex !== plate.index) onReorderPlate(dragIndex, plate.index)
              setDragIndex(null)
              setDragOverIndex(null)
            }}
            aria-label={`Select ${label}`}
            aria-current={active}
            sx={{
              // Expanded: fixed-width tile sized to the (square) thumbnail; the label must not
              // stretch it, so cap the width and let the label truncate within it. Collapsed:
              // a name-only chip with the options menu inline.
              flex: collapsed ? '0 0 auto' : '0 0 92px',
              width: collapsed ? 'auto' : 92,
              minWidth: collapsed ? 0 : 92,
              maxWidth: collapsed ? 160 : 92,
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
              // Reorder-drag feedback: dim the tile being dragged and ring the tile
              // the plate will land on.
              ...(dragIndex === plate.index ? { opacity: 0.45 } : {}),
              ...(dragIndex !== null && dragIndex !== plate.index && dragOverIndex === plate.index
                ? { boxShadow: 'inset 0 0 0 2px var(--joy-palette-primary-400)' }
                : {})
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
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', onClick: (event: React.MouseEvent) => event.stopPropagation(), 'aria-label': `Plate ${plate.index} options` } }}
                sx={collapsed
                  ? { flexShrink: 0, minHeight: 22, minWidth: 22, '--IconButton-size': '22px' }
                  : { position: 'absolute', top: 2, right: 2, minHeight: 22, minWidth: 22, '--IconButton-size': '22px' }}
              >
                <MoreVertRoundedIcon fontSize="small" />
              </MenuButton>
              <Menu placement="bottom-end" sx={{ zIndex: (theme) => theme.zIndex.tooltip, minWidth: 160 }} onClick={(event) => event.stopPropagation()}>
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
          sx={{ flex: '0 0 auto', alignSelf: 'center', ml: 'auto !important' }}
        >
          {collapsed ? <UnfoldMoreRoundedIcon fontSize="small" /> : <UnfoldLessRoundedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Stack>
    </Sheet>
  )
}

/** Material number + swatch + label + colour name for filament pickers (options AND value). */
export function FilamentOptionContent({ option }: { option: FilamentOption }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0, minWidth: '1.1em', textAlign: 'right' }}>
        {option.id}
      </Typography>
      <Box sx={{ width: 12, height: 12, borderRadius: '3px', flexShrink: 0, bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
      <Typography level="body-sm" noWrap>{option.label}</Typography>
      {option.colorName || option.color ? (
        <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flexShrink: 1, minWidth: 0 }}>
          {option.colorName ?? option.color}
        </Typography>
      ) : null}
    </Box>
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
 * (keeps each button narrow so the whole row fits typical editor widths — Joy
 * has no vertical-content button variant, hence the column-flex override).
 *
 * ButtonGroup rounds its corners by cloning DIRECT children with
 * `data-first-child`/`data-last-child` and styling `& > [data-*-child]` — those
 * attributes land on this component, so they must be forwarded to the real
 * button (still a direct DOM child: Tooltip renders no wrapper element).
 */
function ToolbarButton({ entry, isMobile, ...groupAttrs }: {
  entry: ToolbarEntry
  isMobile: boolean
  'data-first-child'?: string
  'data-last-child'?: string
}) {
  const variant = entry.active ? ('solid' as const) : ('soft' as const)
  const color = entry.active ? ('primary' as const) : ('neutral' as const)
  return (
    <Tooltip title={entry.label}>
      {isMobile ? (
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
  onArrangeAll
}: {
  mode: GizmoMode
  disabled: boolean
  /** Disables even selection-independent tools (measure) while the viewport is busy. */
  busy: boolean
  /** Auto-arrange is plate-scoped: enabled whenever the plate has models, selection or not. */
  arrangeDisabled: boolean
  onChange: (mode: GizmoMode) => void
  onDropToBed: () => void
  onAutoOrient: () => void
  onArrangeAll: () => void
}) {
  const isMobile = useMobileViewport()
  // Selection tools: everything here needs a selected object — the modal editing
  // tools (the active one highlights) plus the one-shot Drop/Orient actions.
  const tools: ToolbarEntry[] = [
    ...([
      { value: 'translate', label: 'Move', icon: <OpenWithRoundedIcon /> },
      { value: 'rotate', label: 'Rotate', icon: <ThreeSixtyRoundedIcon /> },
      { value: 'scale', label: 'Scale', icon: <AspectRatioRoundedIcon /> },
      // Tap-a-face icon: the tool rests the CLICKED face on the bed. The plane-
      // through-a-shape icon (Flip) reads as slicing, so it marks the Cut tool.
      { value: 'layFace', label: 'Place on face', short: 'Lay flat', icon: <TouchAppRoundedIcon /> },
      { value: 'cut', label: 'Cut', icon: <FlipRoundedIcon /> },
      { value: 'paintSupports', label: 'Paint supports', short: 'Supports', icon: <BrushRoundedIcon /> },
      { value: 'paintSeam', label: 'Paint seam', short: 'Seam', icon: <FormatPaintRoundedIcon /> },
      { value: 'paintColor', label: 'Paint color', short: 'Color', icon: <PaletteRoundedIcon /> },
      { value: 'brimEars', label: 'Brim ears', icon: <AdjustRoundedIcon /> }
    ] as Array<{ value: GizmoMode; label: string; short?: string; icon: JSX.Element }>).map((tool) => ({
      key: tool.value,
      label: tool.label,
      short: tool.short,
      icon: tool.icon,
      active: mode === tool.value,
      disabled,
      onClick: () => onChange(tool.value)
    })),
    { key: 'drop', label: 'Drop to bed', short: 'Drop', icon: <VerticalAlignBottomRoundedIcon />, disabled, onClick: onDropToBed },
    { key: 'orient', label: 'Auto-orient (rest on the largest flat face)', short: 'Orient', icon: <AutoFixHighRoundedIcon />, disabled, onClick: onAutoOrient }
  ]
  // Utilities that work without a selection: plate-wide arrange and measure
  // (still a mode — it highlights while active — but it never edits the scene).
  const utilities: ToolbarEntry[] = [
    { key: 'arrange', label: 'Auto-arrange all models on this plate', short: 'Arrange', icon: <GridViewRoundedIcon />, disabled: arrangeDisabled, onClick: onArrangeAll },
    { key: 'measure', label: 'Measure', icon: <StraightenRoundedIcon />, active: mode === 'measure', disabled: busy, onClick: () => onChange('measure') }
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
    ...(isMobile ? { '--IconButton-size': '30px' } : null)
  }
  return (
    <>
      <ButtonGroup size="sm" variant="soft" sx={groupSx}>
        {tools.map((entry) => <ToolbarButton key={entry.key} entry={entry} isMobile={isMobile} />)}
      </ButtonGroup>
      <ButtonGroup size="sm" variant="soft" sx={groupSx}>
        {utilities.map((entry) => <ToolbarButton key={entry.key} entry={entry} isMobile={isMobile} />)}
      </ButtonGroup>
    </>
  )
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
      <Menu placement="bottom-start" sx={{ zIndex: (theme) => theme.zIndex.tooltip, p: 1.25, maxWidth: 280 }}>
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
 * Bambu-style manual transform panel for the selected object: position (mm),
 * rotation (deg), and per-axis scale (%) with a uniform-lock toggle. Editing a
 * field updates the live object + gizmo; values reflect the current gizmo state.
 */
export function TransformPanel({
  transform,
  heading,
  uniformScale,
  onToggleUniformScale,
  onPosition,
  onRotation,
  onScale
}: {
  transform: SelectedTransform
  /**
   * Shown above the rows when the values describe something other than the selected
   * object — e.g. a selected PART's object-local placement (BambuStudio's "Volume
   * Operations" title). Omitted for the plain object transform.
   */
  heading?: string
  uniformScale: boolean
  onToggleUniformScale: (value: boolean) => void
  onPosition: (axis: 'x' | 'y' | 'z', value: number) => void
  onRotation: (axis: 'x' | 'y' | 'z', value: number) => void
  onScale: (axis: 'x' | 'y' | 'z', value: number) => void
}) {
  return (
    <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm', display: 'flex', flexDirection: 'column', gap: 1 }}>
      {heading && <Typography level="body-xs" sx={{ fontWeight: 600 }}>{heading}</Typography>}
      <AxisRow label="Position (mm)" values={transform.position} step={1} onChange={onPosition} />
      <AxisRow label="Rotation (°)" values={transform.rotationDeg} step={1} onChange={onRotation} />
      <Stack spacing={0.5}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography level="body-xs" textColor="text.tertiary">Scale (%)</Typography>
          <Tooltip title={uniformScale ? 'Uniform scale (locked)' : 'Independent axes'}>
            <IconButton
              size="sm"
              variant={uniformScale ? 'solid' : 'outlined'}
              color={uniformScale ? 'primary' : 'neutral'}
              onClick={() => onToggleUniformScale(!uniformScale)}
              aria-label="Toggle uniform scale"
              aria-pressed={uniformScale}
            >
              {uniformScale ? <LockRoundedIcon fontSize="small" /> : <LockOpenRoundedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Stack>
        <AxisInputs values={transform.scalePct} step={1} onChange={onScale} />
      </Stack>
    </Sheet>
  )
}

function AxisRow({
  label,
  values,
  step,
  onChange
}: {
  label: string
  values: { x: number; y: number; z: number }
  step: number
  onChange: (axis: 'x' | 'y' | 'z', value: number) => void
}) {
  return (
    <Stack spacing={0.5}>
      <Typography level="body-xs" textColor="text.tertiary">{label}</Typography>
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
      sx={{ minWidth: 0, flex: 1, '--Input-decoratorChildHeight': '1rem' }}
    />
  )
}

function roundForDisplay(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

/**
 * "Add" split button: the default click opens the library file picker (the common
 * case); the dropdown offers uploading a local file or cloning an in-project object.
 * Mirrors the Print split button on the printer cards — a `ButtonGroup` with a main
 * `Button` plus an `IconButton` driving an anchored `Menu`.
 */
export function AddModelMenu({
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
  onAddFromLibrary: () => void
  onImportFile: () => void
  onAddPrimitive: (kind: PrimitiveKind) => void
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const blocked = importing || disabled
  return (
    <>
      {/* Soft variant so the caret matches the main button (outlined fills the
          Button but leaves the IconButton transparent in this theme). */}
      <Tooltip title={disabled && disabledReason ? disabledReason : ''} variant="soft">
      <ButtonGroup ref={anchorRef} size="sm" variant="soft" color="neutral" aria-label="add model">
        <Button
          onClick={onAddFromLibrary}
          disabled={blocked}
          startDecorator={importing ? <CircularProgress size="sm" /> : <AddRoundedIcon />}
        >
          Add
        </Button>
        <IconButton
          disabled={blocked}
          aria-controls={menuOpen ? 'add-model-menu' : undefined}
          aria-expanded={menuOpen ? 'true' : undefined}
          aria-haspopup="menu"
          aria-label="More add options"
          onClick={() => setMenuOpen((value) => !value)}
        >
          <ArrowDropDownIcon />
        </IconButton>
      </ButtonGroup>
      </Tooltip>
      <Menu
        id="add-model-menu"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorEl={anchorRef.current}
        placement="bottom-end"
        // The editor is a Modal (zIndex 1300); the menu popper defaults to the
        // lower `popup` layer, so lift it above the dialog or it renders behind it.
        // In a vertical menu Joy's ListItemDecorator only reserves height, not width,
        // so icons of differing glyph widths leave the labels ragged. Pin a fixed icon
        // column and a uniform icon size so every label starts at the same x.
        sx={{
          minWidth: 220,
          zIndex: (theme) => theme.zIndex.tooltip,
          [`& .${listItemDecoratorClasses.root}`]: { minInlineSize: '1.75rem' },
          '& svg': { fontSize: '1.25rem' }
        }}
      >
        <MenuItem onClick={() => { setMenuOpen(false); onAddFromLibrary() }}>
          <ListItemDecorator><InventoryRoundedIcon /></ListItemDecorator>
          From library…
        </MenuItem>
        <MenuItem onClick={() => { setMenuOpen(false); onImportFile() }}>
          <ListItemDecorator><UploadFileRoundedIcon /></ListItemDecorator>
          Upload local file…
        </MenuItem>
        <ListDivider />
        {(Object.keys(PRIMITIVE_LABELS) as PrimitiveKind[]).map((kind) => (
          <MenuItem key={kind} onClick={() => { setMenuOpen(false); onAddPrimitive(kind) }}>
            <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
            Add {PRIMITIVE_LABELS[kind].toLowerCase()}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}

/** Split "Save" button: primary action saves, the caret opens Save-as. Mirrors AddModelMenu. */
export function SaveSplitButton({
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
  // Dropdown drives open/close (incl. click-away + Escape, which a bare anchored Menu
  // lacks); ButtonGroup keeps the split radii and the MenuButton renders as an
  // IconButton so it inherits the group's variant (no transparent/disconnected caret).
  // Solid primary: Save is the footer's primary action (Slice sits soft to its left).
  // "Save (version)" overwrites the open file, so it greys out until there are unsaved
  // edits (matching Bambu Studio's Ctrl+S). "Save as new…" always stays available — both
  // as the new-project path (no version to save) and as a safety valve if a change ever
  // slips past dirty tracking. The caret stays enabled so Save-as is always reachable.
  const saveVersionDisabled = disabled || saving || !dirty
  return (
    <Dropdown>
      <ButtonGroup variant="solid" color="primary" aria-label="save">
        <Button
          loading={saving}
          disabled={canSaveVersion ? saveVersionDisabled : disabled || saving}
          startDecorator={<SaveRoundedIcon />}
          onClick={() => (canSaveVersion ? onSaveVersion() : onSaveAs())}
        >Save</Button>
        <MenuButton slots={{ root: IconButton }} disabled={disabled || saving} aria-label="More save options">
          <ArrowDropDownIcon />
        </MenuButton>
      </ButtonGroup>
      <Menu placement="bottom-end" sx={{ minWidth: 200, zIndex: (theme) => theme.zIndex.tooltip }}>
        {canSaveVersion && <MenuItem disabled={saveVersionDisabled} onClick={onSaveVersion}>Save</MenuItem>}
        <MenuItem onClick={onSaveAs}>Save as new…</MenuItem>
      </Menu>
    </Dropdown>
  )
}

/** Split "Slice" button: primary slices the active plate, the caret offers all plates. */
export function SliceSplitButton({
  slicing,
  disabled,
  disabledReason,
  activePlateIndex,
  onSliceAll,
  onSlicePlate
}: {
  slicing: boolean
  disabled: boolean
  disabledReason?: string
  activePlateIndex: number
  onSliceAll: () => void
  onSlicePlate: () => void
}) {
  // Phones are tight on footer width; "Slice plate" wraps to two lines there.
  const isMobile = useMobileViewport()
  const group = (
    <Dropdown>
      {/* Soft: Save (solid, rightmost) is the footer's primary action. */}
      <ButtonGroup variant="soft" color="primary" disabled={disabled} aria-label="slice">
        <Button startDecorator={<LayersRoundedIcon />} loading={slicing} onClick={onSlicePlate}>
          {isMobile ? 'Slice' : 'Slice plate'}
        </Button>
        <MenuButton slots={{ root: IconButton }} aria-label="More slice options">
          <ArrowDropDownIcon />
        </MenuButton>
      </ButtonGroup>
      <Menu placement="top-end" sx={{ minWidth: 200, zIndex: (theme) => theme.zIndex.tooltip }}>
        <MenuItem onClick={onSlicePlate}>Slice plate {activePlateIndex}</MenuItem>
        <MenuItem onClick={onSliceAll}>Slice all plates</MenuItem>
      </Menu>
    </Dropdown>
  )
  // A disabled native button swallows hover events, so wrap the group in an element that still
  // receives them; this lets the tooltip explain *why* the Slice button is unavailable.
  if (disabled && disabledReason) {
    return (
      <Tooltip title={disabledReason} variant="soft" sx={{ maxWidth: 280 }}>
        <Box sx={{ display: 'inline-flex' }}>{group}</Box>
      </Tooltip>
    )
  }
  return group
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
  title
}: {
  filamentId: number | null
  color: string | null
  options?: FilamentOption[]
  onReassign?: (filamentId: number) => void
  title?: string
}) {
  const interactive = Boolean(onReassign && options && options.length > 0)
  if (filamentId == null && !interactive) return null
  const swatch = (
    <Box
      sx={{
        flexShrink: 0,
        width: 20,
        height: 20,
        borderRadius: '4px',
        bgcolor: color || 'neutral.softBg',
        border: '1px solid rgba(255,255,255,0.18)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <Typography level="body-xs" sx={{ fontWeight: 700, lineHeight: 1, color: filamentTextColor(color) }}>
        {filamentId ?? '+'}
      </Typography>
    </Box>
  )
  if (!interactive) {
    return <Tooltip title={title ?? `Material ${filamentId}`}>{swatch}</Tooltip>
  }
  return (
    <Dropdown>
      <Tooltip title={title ?? 'Change material'}>
        <MenuButton
          variant="plain"
          color="neutral"
          aria-label={title ?? 'Change material'}
          sx={{ p: 0, minHeight: 0, minWidth: 0, border: 'none', background: 'none', '&:hover': { background: 'none' }, flexShrink: 0 }}
        >
          {swatch}
        </MenuButton>
      </Tooltip>
      <Menu placement="bottom-end" sx={{ zIndex: (theme) => theme.zIndex.tooltip, minWidth: 180 }}>
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
            <span>Material {option.id}{option.label ? ` — ${option.label}` : ''}{option.colorName ? ` (${option.colorName})` : ''}</span>
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  )
}

/** The "Change type" options for session-ADDED part volumes (never normal parts). */
const ADDED_PART_TYPE_OPTIONS = PART_SUBTYPE_OPTIONS.filter((option) => option.subtype !== 'normal_part')

/**
 * Per-part "Change type" menu (BambuStudio's right-click → Change type): pick the part's
 * Bambu volume subtype. A non-normal part shows a highlighted trigger so retyped parts are
 * visible at a glance in the list. Added part volumes pass the reduced option list
 * (they can never become normal parts).
 */
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
  const current = subtype ?? 'normal_part'
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
      <Menu placement="bottom-end" sx={{ zIndex: (theme) => theme.zIndex.tooltip }}>
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
 * The Objects sidebar list. Each row selects/duplicates/deletes the model. When
 * `perObject` is supplied (slice settings present), the row also carries the
 * per-object controls that used to live in a separate dialog: a print on/off
 * toggle and an override editor (with a badge for the override count).
 */
export function ModelList({
  instances,
  selectedKey,
  extraSelectedKeys,
  partSelection,
  selectedBakedPart,
  onSelect,
  onSelectPart,
  onObjectContextMenu,
  onPartContextMenu,
  filamentColors,
  filamentOptions,
  onReassignFilament,
  resolveFilamentId,
  onTogglePrintable,
  onChangePartType,
  addedPartsFor,
  selectedAddedPartKey,
  onSelectAddedPart,
  onChangeAddedPartType,
  onRemoveAddedPart,
  onEditAddedPartSettings,
  perObject
}: {
  instances: EditorInstance[]
  selectedKey: string | null
  /** Additional multi-selected instance keys (Ctrl/Cmd-click). */
  extraSelectedKeys?: ReadonlyArray<string>
  /** Selected PARTS of one object (mutually exclusive with the object selection). */
  partSelection?: { objectId: number; componentObjectIds: ReadonlyArray<number> } | null
  /** The baked part currently holding the transform gizmo (row highlight). */
  selectedBakedPart?: { objectId: number; componentObjectId: number } | null
  onSelect: (key: string, modifiers?: { additive?: boolean; range?: boolean }) => void
  /**
   * Select a part row: plain click hands the part the gizmo (move/rotate/scale);
   * Ctrl-toggle / Shift-range build the bulk selection (BambuStudio volume-mode rules).
   */
  onSelectPart?: (objectId: number, componentObjectId: number, modifiers: { additive: boolean; range: boolean }, instanceKey: string) => void
  /** Right-click on an object row: open the object context menu at the pointer. */
  onObjectContextMenu?: (key: string, position: { x: number; y: number }) => void
  /** Right-click on a part row: open the part context menu at the pointer. */
  onPartContextMenu?: (objectId: number, componentObjectId: number, position: { x: number; y: number }) => void
  filamentColors?: Record<number, string>
  filamentOptions?: FilamentOption[]
  onReassignFilament?: (targets: Array<{ objectId: number; componentObjectId: number }>, filamentId: number) => void
  /** Map a (possibly-removed) material id to the one shown (removed -> material 1). */
  resolveFilamentId?: (id: number | null) => number | null
  /** Toggle an instance's Bambu "Printable" flag (per-instance, editor-owned). */
  onTogglePrintable: (key: string) => void
  /** Change a part's Bambu volume type (BambuStudio's "Change type"), keyed like part filament. */
  onChangePartType?: (objectId: number, componentObjectId: number, subtype: SceneEditPartSubtype) => void
  /** Part volumes ADDED this session (blockers/enforcers/modifiers/negatives) for an instance's object. */
  addedPartsFor?: (instance: EditorInstance) => EditorAddedPart[]
  /** The added part currently holding the transform gizmo (row highlight). */
  selectedAddedPartKey?: string | null
  /** Select an added part row: selects the instance and hands the part the gizmo. */
  onSelectAddedPart?: (instanceKey: string, partKey: string) => void
  onChangeAddedPartType?: (partKey: string, subtype: SceneEditAddedPartSubtype) => void
  onRemoveAddedPart?: (partKey: string) => void
  /** Open per-volume process settings for a modifier part (needs slice settings). */
  onEditAddedPartSettings?: (partKey: string) => void
  /** Slice-config per-object process overrides (keyed by Bambu objectId). Null without a profile. */
  perObject?: {
    sliceObjectIds: Set<number>
    overrideCountFor: (objectId: number) => number
    onEditObject: (objectId: number, name: string) => void
    /** Open per-PART process settings for one part of an object (separate from the object's). */
    onEditPart?: (objectId: number, componentObjectId: number, name: string) => void
    partOverrideCountFor?: (objectId: number, componentObjectId: number) => number
  }
}) {
  const resolveId = resolveFilamentId ?? ((id: number | null) => id)
  const liveColor = (filamentId: number | null, fallback: string | null): string | null =>
    (filamentId != null && filamentColors?.[filamentId]) || fallback || null
  return (
    <List size="sm" sx={{ '--ListItem-minHeight': '2.5rem' }}>
      {instances.map((instance) => {
        // The object identity used for per-object settings AND per-part filament reassignment:
        // an in-project object's Bambu id, or an import's stable identity (synthetic for a fresh
        // import, the replaced object's id for "Replace with…") — so a not-yet-saved import's
        // parts are reassignable and its process is editable without a save first.
        const perObjectId = instance.source.kind === 'object'
          ? instance.objectId
          : (instance.source.replacedObjectId ?? null)
        const sliceObject = perObjectId != null && perObject?.sliceObjectIds.has(perObjectId) ? perObjectId : null
        // Printability is an editor-owned per-instance flag (BambuStudio's "Printable"),
        // so the toggle shows for every object on the plate — including just-moved ones —
        // independent of the slice dialog's per-plate object selection.
        const printing = instance.printable
        const overrideCount = sliceObject != null ? perObject!.overrideCountFor(sliceObject) : 0
        // Objects can hold multiple parts, each on its own filament — list them nested.
        const showParts = instance.parts.length > 1
        return (
          <Fragment key={instance.key}>
            <ListItem
              onContextMenu={onObjectContextMenu ? (event) => {
                event.preventDefault()
                onObjectContextMenu(instance.key, { x: event.clientX, y: event.clientY })
              } : undefined}
              sx={{ borderRadius: 'sm', bgcolor: instance.key === selectedKey ? 'neutral.softBg' : extraSelectedKeys?.includes(instance.key) ? 'neutral.plainActiveBg' : undefined }}
            >
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
                <Tooltip title={printing ? 'Printable — toggle to skip' : 'Skipped — toggle to print'} variant="soft">
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
                  onClick={(event) => onSelect(instance.key, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey })}
                  // userSelect off so a Shift-range click extends the selection instead of
                  // highlighting the row names as text.
                  sx={{ flex: 1, minWidth: 0, cursor: 'pointer', userSelect: 'none', opacity: printing ? 1 : 0.5 }}
                >
                  {instance.name}
                </Typography>
                {perObjectId != null && onReassignFilament && instance.parts.length > 0 ? (
                  <FilamentBadge
                    filamentId={showParts ? null : resolveId(instance.filamentId)}
                    color={showParts ? null : liveColor(resolveId(instance.filamentId), instance.color)}
                    options={filamentOptions}
                    title={showParts ? "Set all parts' material" : 'Change material'}
                    onReassign={(fid) => onReassignFilament(instance.parts.map((p) => ({ objectId: perObjectId, componentObjectId: p.componentObjectId })), fid)}
                  />
                ) : (!showParts && <FilamentBadge filamentId={resolveId(instance.filamentId)} color={liveColor(resolveId(instance.filamentId), instance.color)} />)}
                {perObject && sliceObject != null && (
                  <Tooltip title="Per-object settings">
                    <IconButton
                      size="sm"
                      variant={overrideCount > 0 ? 'soft' : 'plain'}
                      color={overrideCount > 0 ? 'primary' : 'neutral'}
                      onClick={() => perObject.onEditObject(sliceObject, instance.name)}
                      aria-label={`Per-object settings for ${instance.name}`}
                    >
                      <TuneRoundedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            </ListItem>
            {showParts && instance.parts.map((part, index) => {
              const partSelected = perObjectId != null
                && ((partSelection?.objectId === perObjectId
                  && partSelection.componentObjectIds.includes(part.componentObjectId))
                  || (selectedBakedPart?.objectId === perObjectId
                    && selectedBakedPart.componentObjectId === part.componentObjectId))
              return (
              <ListItem
                key={`${instance.key}:${index}`}
                onContextMenu={onPartContextMenu && perObjectId != null ? (event) => {
                  event.preventDefault()
                  onPartContextMenu(perObjectId, part.componentObjectId, { x: event.clientX, y: event.clientY })
                } : undefined}
                sx={{ pl: 3, borderRadius: 'sm', bgcolor: partSelected ? 'neutral.softBg' : undefined }}
              >
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%', minWidth: 0, opacity: printing ? 0.85 : 0.4 }}>
                  <Typography
                    level="body-xs"
                    noWrap
                    onClick={onSelectPart && perObjectId != null ? (event) => {
                      onSelectPart(perObjectId, part.componentObjectId, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey }, instance.key)
                    } : undefined}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      ...(onSelectPart && perObjectId != null ? { cursor: 'pointer', userSelect: 'none' } : {})
                    }}
                  >
                    {part.name ?? `Part ${index + 1}`}
                  </Typography>
                  <FilamentBadge
                    filamentId={resolveId(part.filamentId)}
                    color={liveColor(resolveId(part.filamentId), part.color)}
                    options={filamentOptions}
                    onReassign={onReassignFilament && perObjectId != null ? (fid) => onReassignFilament([{ objectId: perObjectId, componentObjectId: part.componentObjectId }], fid) : undefined}
                  />
                  {onChangePartType && perObjectId != null && (
                    <PartTypeMenu
                      subtype={part.subtype}
                      partName={part.name ?? `Part ${index + 1}`}
                      onChange={(subtype) => onChangePartType(perObjectId, part.componentObjectId, subtype)}
                    />
                  )}
                  {perObject?.onEditPart && sliceObject != null && (() => {
                    const partOverrides = perObject!.partOverrideCountFor?.(sliceObject, part.componentObjectId) ?? 0
                    return (
                      <Tooltip title="Per-part settings">
                        <IconButton
                          size="sm"
                          variant={partOverrides > 0 ? 'soft' : 'plain'}
                          color={partOverrides > 0 ? 'primary' : 'neutral'}
                          onClick={() => perObject!.onEditPart!(sliceObject, part.componentObjectId, part.name ?? `Part ${index + 1}`)}
                          aria-label={`Per-part settings for ${part.name ?? `Part ${index + 1}`}`}
                        >
                          <TuneRoundedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )
                  })()}
                </Stack>
              </ListItem>
              )
            })}
            {(addedPartsFor?.(instance) ?? []).map((part) => (
              // Part volumes added THIS session (support blocker/enforcer, modifier, negative):
              // they only become real `<component>` parts at save time, so list them from the
              // session state — otherwise a freshly added blocker is invisible here until a
              // save + reopen. Clicking hands the part the transform gizmo.
              <ListItem
                key={part.key}
                sx={{ pl: 3, borderRadius: 'sm', bgcolor: part.key === selectedAddedPartKey ? 'neutral.softBg' : undefined }}
              >
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%', minWidth: 0, opacity: printing ? 0.85 : 0.4 }}>
                  <Box
                    sx={{
                      width: 12,
                      height: 12,
                      borderRadius: '3px',
                      flexShrink: 0,
                      bgcolor: `#${ADDED_PART_SPECS[part.subtype].color.toString(16).padStart(6, '0')}`
                    }}
                  />
                  <Typography
                    level="body-xs"
                    noWrap
                    onClick={onSelectAddedPart ? () => onSelectAddedPart(instance.key, part.key) : undefined}
                    sx={{ flex: 1, minWidth: 0, ...(onSelectAddedPart ? { cursor: 'pointer', userSelect: 'none' } : {}) }}
                  >
                    {part.name}
                  </Typography>
                  {onChangeAddedPartType && (
                    <PartTypeMenu
                      subtype={part.subtype}
                      partName={part.name}
                      options={ADDED_PART_TYPE_OPTIONS}
                      // The reduced option list never yields 'normal_part', so the narrowing cast is safe.
                      onChange={(subtype) => onChangeAddedPartType(part.key, subtype as SceneEditAddedPartSubtype)}
                    />
                  )}
                  {part.subtype === 'modifier_part' && onEditAddedPartSettings && (
                    <Tooltip title="Modifier settings">
                      <IconButton
                        size="sm"
                        variant={Object.keys(part.settings ?? {}).length > 0 ? 'soft' : 'plain'}
                        color={Object.keys(part.settings ?? {}).length > 0 ? 'primary' : 'neutral'}
                        onClick={() => onEditAddedPartSettings(part.key)}
                        aria-label={`Modifier settings for ${part.name}`}
                      >
                        <TuneRoundedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  {onRemoveAddedPart && (
                    <Tooltip title="Remove part">
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="danger"
                        onClick={() => onRemoveAddedPart(part.key)}
                        aria-label={`Remove ${part.name}`}
                      >
                        <DeleteRoundedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>
              </ListItem>
            ))}
          </Fragment>
        )
      })}
    </List>
  )
}

/**
 * Click-driven help popup for a sidebar section heading (not a hover Tooltip, so it
 * also opens on touch devices). Carries the section's explanatory copy so the section
 * itself stays compact — the Filament changes / Pauses pair sits side by side under
 * the object list and must not eat the list's vertical space.
 */
function SectionHelpPopup({ ariaLabel, title, children }: {
  ariaLabel: string
  title: string
  children: ReactNode
}) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': ariaLabel } }}
      >
        <HelpOutlineRoundedIcon fontSize="small" />
      </MenuButton>
      <Menu placement="bottom-start" sx={{ zIndex: (theme) => theme.zIndex.tooltip, p: 1.25, maxWidth: 300 }}>
        <Typography level="title-sm" sx={{ mb: 0.75 }}>{title}</Typography>
        <Stack spacing={0.75}>{children}</Stack>
      </Menu>
    </Dropdown>
  )
}

/**
 * The per-plate "Pauses" section rendered under the Objects list: layer pauses entered
 * by print height (mm), mirroring the filament-change rows. Baked to PausePrint entries
 * in `Metadata/custom_gcode_per_layer.xml` on save. Sized to share a row with
 * {@link PlateFilamentChangesSection} (wrapping under it when the panel is narrow).
 */
export function PlatePausesSection({ pauses, onChange }: {
  pauses: EditorPause[]
  onChange: (pauses: EditorPause[]) => void
}) {
  return (
    <Stack spacing={0.75} sx={{ flex: '1 1 150px', minWidth: 0 }}>
      <Stack direction="row" spacing={0.25} alignItems="center">
        <Typography level="title-sm">Pauses</Typography>
        <SectionHelpPopup ariaLabel="About pauses" title="Pauses">
          <Typography level="body-xs">
            Stop the print at a height, e.g. to embed magnets or nuts, then resume from
            the printer screen.
          </Typography>
          <Typography level="body-xs">
            The printer stops just before it prints the layer that ends at the height you
            enter. With 0.2 mm layers, a pause at 5.0 mm stops once 4.8 mm has printed.
          </Typography>
          <Typography level="body-xs">
            Each pause shows as an amber line on the models, and the height keeps working
            if you change the layer height later.
          </Typography>
          <Typography level="body-xs">
            Need an exact layer? Slice the plate, scrub the G-code preview to the layer you
            want, and enter the height shown next to the layer number.
          </Typography>
        </SectionHelpPopup>
      </Stack>
      {pauses.map((pause, index) => (
        <Stack key={index} direction="row" spacing={0.75} alignItems="center">
          <Input
            size="sm"
            type="number"
            value={pause.z}
            endDecorator="mm"
            slotProps={{ input: { min: 0.2, step: 0.2, 'aria-label': 'Pause height' } }}
            onChange={(event) => {
              const next = Number.parseFloat(event.target.value)
              if (!Number.isFinite(next) || next <= 0) return
              onChange(pauses.map((entry, i) => (i === index ? { z: next } : entry)))
            }}
            sx={{ flex: 1, minWidth: 84 }}
          />
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Remove pause"
            onClick={() => onChange(pauses.filter((_, i) => i !== index))}
          >
            <CloseRoundedIcon />
          </IconButton>
        </Stack>
      ))}
      <Button
        size="sm"
        variant="soft"
        startDecorator={<AddRoundedIcon />}
        onClick={() => {
          const lastZ = pauses[pauses.length - 1]?.z ?? 0
          onChange([...pauses, { z: Math.round((lastZ + 1) * 10) / 10 }])
        }}
        sx={{ alignSelf: 'flex-start' }}
      >
        Add pause
      </Button>
    </Stack>
  )
}

/**
 * The per-plate "Filament changes" section: layer-based whole-plate material swaps
 * entered by print height (mm), baked to tool-change entries in
 * `Metadata/custom_gcode_per_layer.xml` on save. Shares a row with
 * {@link PlatePausesSection}, so the row keeps a compact swatch+id material select
 * (the open listbox still shows the full material names).
 */
export function PlateFilamentChangesSection({ changes, filamentOptions, onChange }: {
  changes: EditorFilamentChange[]
  filamentOptions: FilamentOption[]
  onChange: (changes: EditorFilamentChange[]) => void
}) {
  return (
    <Stack spacing={0.75} sx={{ flex: '1 1 190px', minWidth: 0 }}>
      <Stack direction="row" spacing={0.25} alignItems="center">
        <Typography level="title-sm">Filament changes</Typography>
        <SectionHelpPopup ariaLabel="About filament changes" title="Filament changes">
          <Typography level="body-xs">
            Swap to another material at a print height. The whole plate changes colour
            from that layer up.
          </Typography>
          <Typography level="body-xs">
            Need an exact layer? Slice the plate, scrub the G-code preview to the layer you
            want, and enter the height shown next to the layer number.
          </Typography>
        </SectionHelpPopup>
      </Stack>
      {changes.map((change, index) => (
        <Stack key={index} direction="row" spacing={0.75} alignItems="center">
          <Input
            size="sm"
            type="number"
            value={change.z}
            endDecorator="mm"
            slotProps={{ input: { min: 0.2, step: 0.2, 'aria-label': 'Change height' } }}
            onChange={(event) => {
              const next = Number.parseFloat(event.target.value)
              if (!Number.isFinite(next) || next <= 0) return
              onChange(changes.map((entry, i) => (i === index ? { ...entry, z: next } : entry)))
            }}
            sx={{ flex: 1, minWidth: 84 }}
          />
          <Select<number>
            size="sm"
            value={change.filamentId}
            onChange={(_event, value) => {
              if (value == null) return
              onChange(changes.map((entry, i) => (i === index ? { ...entry, filamentId: value } : entry)))
            }}
            renderValue={(selected) => {
              const option = filamentOptions.find((entry) => entry.id === selected?.value)
              if (!option) return null
              return (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Box sx={{ width: 12, height: 12, borderRadius: '3px', flexShrink: 0, bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
                  <span>{option.id}</span>
                </Stack>
              )
            }}
            slotProps={{ button: { 'aria-label': 'Change to material' } }}
            sx={{ minWidth: 64, flexShrink: 0 }}
          >
            {filamentOptions.map((option) => (
              <Option key={option.id} value={option.id}>
                <FilamentOptionContent option={option} />
              </Option>
            ))}
          </Select>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Remove filament change"
            onClick={() => onChange(changes.filter((_, i) => i !== index))}
          >
            <CloseRoundedIcon />
          </IconButton>
        </Stack>
      ))}
      <Button
        size="sm"
        variant="soft"
        startDecorator={<AddRoundedIcon />}
        onClick={() => {
          const lastZ = changes[changes.length - 1]?.z ?? 0
          const lastFilament = changes[changes.length - 1]?.filamentId
          const nextOption = filamentOptions.find((option) => option.id !== (lastFilament ?? filamentOptions[0]?.id))
          onChange([
            ...changes,
            { z: Math.round((lastZ + 1) * 10) / 10, filamentId: nextOption?.id ?? filamentOptions[0]?.id ?? 1 }
          ])
        }}
        sx={{ alignSelf: 'flex-start' }}
      >
        Add change
      </Button>
    </Stack>
  )
}
