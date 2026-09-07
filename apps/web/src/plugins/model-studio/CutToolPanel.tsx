/**
 * Floating control panel for the editor's cut tool: the cut mode (a plain plane, or BambuStudio's
 * interlocking dovetail), axis (X/Y/Z), plane position (numeric + slider, clamped to the object's
 * range), which halves to keep, what each kept half's orientation becomes, and Cut/Cancel.
 *
 * Pure presentational surface: the cut state, the live cut-plane preview mesh, and the actual
 * mesh-cut execution all live in EditorView; this only renders the controls and calls back.
 *
 * Angles are DEGREES on this surface and radians in `GrooveCut`, matching Studio, whose sliders do
 * the same conversion; the boundary is here so nothing downstream has to ask which unit it holds.
 */
import { Alert, Box, Button, ButtonGroup, Checkbox, Input, Sheet, Slider, Stack, Typography } from '@mui/joy'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import { CUT_AXIS_SIDES } from './editorGeometry'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import { TOOL_PANEL_Z_INDEX } from './editorLayers'
import { NumberField } from './NumberField'
import { GROOVE_CUT_LIMITS, isGrooveShapeValid } from './lib/meshCut'
import type { CutAxis, CutHalfOrientation, CutMode, GrooveCut } from './lib/meshCut'
import type {
  ConnectorSettings,
  CutConnectorShape,
  CutConnectorStyle,
  CutConnectorType
} from './lib/cutConnectors'

/** Studio's own order and labels (`GLGizmoAdvancedCut.cpp:3002`), less the unfinished Thread. */
const CONNECTOR_TYPE_CHOICES: ReadonlyArray<{ value: CutConnectorType; label: string; hint: string }> = [
  { value: 'plug', label: 'Plug', hint: 'A peg on one half and a matching hole in the other' },
  { value: 'dowel', label: 'Dowel', hint: 'A hole in both halves and a loose pin printed alongside' },
  { value: 'snap', label: 'Snap', hint: 'A springy barbed peg that clicks into a round socket' }
]

const CONNECTOR_STYLE_CHOICES: ReadonlyArray<{ value: CutConnectorStyle; label: string; hint: string }> = [
  { value: 'prism', label: 'Straight', hint: 'Straight sides' },
  { value: 'frustum', label: 'Tapered', hint: 'Tapered, so it guides itself in' }
]

const CONNECTOR_SHAPE_CHOICES: ReadonlyArray<{ value: CutConnectorShape; label: string }> = [
  { value: 'circle', label: 'Circle' },
  { value: 'hexagon', label: 'Hex' },
  { value: 'square', label: 'Square' },
  { value: 'triangle', label: 'Tri' }
]

/** Studio's connector tolerance bounds, in millimetres (`render_slider_double_input`, 0 to 2). */
const CONNECTOR_TOLERANCE_LIMITS = { min: 0, max: 2 }

const DEGREES_PER_RADIAN = 180 / Math.PI

/**
 * A segmented single-choice row: every option a peer button, the chosen one solid.
 *
 * File-local because this panel is its only caller, but extracted because it is the panel's THIRD
 * such row (cut mode, axis, and each kept half's orientation) and the three had already begun to
 * drift apart on `aria-pressed` and button padding.
 */
function SegmentedChoice<T extends string>({ label, value, options, onChange, fullWidth = false }: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string; hint?: string; ariaLabel?: string }>
  onChange: (value: T) => void
  /** Fill the row. Off for a group sharing its row with another control, which sizes to content. */
  fullWidth?: boolean
}) {
  return (
    <ButtonGroup size="sm" variant="soft" aria-label={label} sx={fullWidth ? { width: '100%' } : undefined}>
      {options.map((option) => (
        <Button
          key={option.value}
          title={option.hint}
          aria-label={option.ariaLabel}
          aria-pressed={value === option.value}
          variant={value === option.value ? 'solid' : 'soft'}
          color={value === option.value ? 'primary' : 'neutral'}
          onClick={() => onChange(option.value)}
          sx={fullWidth ? { flex: 1, minWidth: 0, px: 0.5 } : undefined}
        >
          {option.label}
        </Button>
      ))}
    </ButtonGroup>
  )
}

/** BambuStudio's per-half after-cut choices, in its own order. */
const ORIENTATION_CHOICES: ReadonlyArray<{ value: CutHalfOrientation; label: string; hint: string }> = [
  { value: 'keep', label: 'Keep', hint: 'Keep orientation' },
  { value: 'placeOnCut', label: 'On cut', hint: 'Place on cut: rest the piece on its cut face' },
  { value: 'flip', label: 'Flip', hint: 'Flip upside down' }
]

/** The two shapes the tool can cut. Studio's `CutMode` also has `cutByLine`, which we do not offer. */
const CUT_MODE_CHOICES: ReadonlyArray<{ value: CutMode; label: string; hint: string }> = [
  { value: 'plane', label: 'Plane', hint: 'Split into two flat-faced halves' },
  { value: 'dovetail', label: 'Dovetail', hint: 'Split with an interlocking tongue and groove' }
]

const CUT_AXIS_CHOICES: ReadonlyArray<{ value: CutAxis; label: string }> = [
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' }
]

export interface CutToolPanelProps {
  cutMode: CutMode
  setCutMode: (mode: CutMode) => void
  /** Dovetail geometry, in the units {@link GrooveCut} documents (radians for the angles). */
  groove: GrooveCut
  setGroove: (groove: GrooveCut) => void
  /** What depth and width may be, derived from the model by `grooveSizeLimitsForSize`. */
  grooveSizeLimits: { min: number; max: number }
  /**
   * Connector settings, shared by every connector on this cut rather than held per connector.
   * Studio edits its SELECTION instead and blanks fields where the selection disagrees; uniform
   * settings need no selection model and match what a joint wants, which is matching pegs.
   */
  connectorSettings: ConnectorSettings
  setConnectorSettings: (settings: ConnectorSettings) => void
  /** How many connectors are placed, and whether clicking the cut plane places more. */
  connectorCount: number
  connectorMode: boolean
  setConnectorMode: (on: boolean) => void
  /**
   * Which half stays visible while placing, so a face that is awkward from one side can be reached
   * from the other. Studio flips its own clipped side as the camera moves; this is the explicit
   * version of the same choice.
   */
  connectorFace: 'lower' | 'upper'
  setConnectorFace: (face: 'lower' | 'upper') => void
  clearConnectors: () => void
  /** Studio's warning text when any connector cannot be cut; null when all are fine. */
  connectorWarning: string | null
  /**
   * Bounds for the Size (a DIAMETER) and Depth fields, derived from the model exactly as the
   * groove's are: 1mm up to the bounding box's summed dimensions halved.
   */
  connectorSizeLimits: { min: number; max: number }
  cutAxis: CutAxis
  setCutAxis: (axis: CutAxis) => void
  cutOffset: number
  setCutOffset: (value: number) => void
  /** The selected object's extent along the cut axis (panel only renders when this is known). */
  cutRange: { min: number; max: number }
  /** `cutOffset` clamped into `cutRange`: what the slider/preview actually use. */
  clampedCutOffset: number
  cutKeepLower: boolean
  setCutKeepLower: (value: boolean) => void
  cutKeepUpper: boolean
  setCutKeepUpper: (value: boolean) => void
  /** What each kept half's orientation becomes after the cut. */
  cutOrientLower: CutHalfOrientation
  setCutOrientLower: (value: CutHalfOrientation) => void
  cutOrientUpper: CutHalfOrientation
  setCutOrientUpper: (value: CutHalfOrientation) => void
  /** A cut is running (disables inputs, shows the spinner). */
  cutting: boolean
  onCut: () => void
  onCancel: () => void
}

export function CutToolPanel({
  cutMode, setCutMode, groove, setGroove, grooveSizeLimits,
  connectorSettings, setConnectorSettings, connectorCount, connectorMode, setConnectorMode,
  connectorFace, setConnectorFace,
  clearConnectors, connectorWarning, connectorSizeLimits,
  cutAxis, setCutAxis, cutOffset, setCutOffset, cutRange, clampedCutOffset,
  cutKeepLower, setCutKeepLower, cutKeepUpper, setCutKeepUpper,
  cutOrientLower, setCutOrientLower, cutOrientUpper, setCutOrientUpper,
  cutting, onCut, onCancel
}: CutToolPanelProps) {
  const sides = CUT_AXIS_SIDES[cutAxis]
  const dovetail = cutMode === 'dovetail'
  // Studio's own gate (`has_valid_groove`): past a right angle the flanks can close on each other
  // before reaching the mouth, leaving no groove to cut.
  const grooveValid = !dovetail || isGrooveShapeValid(groove)
  const grooveField = (
    label: string,
    value: number,
    limits: { min: number; max: number },
    apply: (next: number) => GrooveCut
  ) => (
    <NumberField label={label} value={value} limits={limits} onChange={(next) => setGroove(apply(next))} />
  )
  /** One kept half's orientation row; hidden entirely when that half is being discarded. */
  const orientationRow = (
    kept: boolean,
    sideLabel: string,
    value: CutHalfOrientation,
    onChange: (next: CutHalfOrientation) => void
  ) => kept && (
    <Stack key={sideLabel} direction="row" spacing={0.75} alignItems="center">
      <Typography level="body-xs" textColor="text.tertiary" sx={{ width: 40, flexShrink: 0, textTransform: 'capitalize' }}>
        {sideLabel}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <SegmentedChoice
          fullWidth
          label={`${sideLabel} half orientation`}
          value={value}
          onChange={onChange}
          options={ORIENTATION_CHOICES.map((choice) => ({
            value: choice.value,
            label: choice.label,
            hint: choice.hint,
            ariaLabel: `${sideLabel}: ${choice.hint}`
          }))}
        />
      </Box>
    </Stack>
  )

  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute', ...TOOL_PANEL_ANCHOR, zIndex: TOOL_PANEL_Z_INDEX,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
        width: 'min(260px, calc(100% - 16px))',
        display: 'flex', flexDirection: 'column', gap: 0.75
      }}
    >
      <Typography level="title-sm">Cut</Typography>
      <SegmentedChoice
        fullWidth
        label="Cut mode"
        value={cutMode}
        onChange={setCutMode}
        options={CUT_MODE_CHOICES}
      />
      <Stack direction="row" spacing={0.75} alignItems="center">
        <SegmentedChoice label="Cut plane axis" value={cutAxis} onChange={setCutAxis} options={CUT_AXIS_CHOICES} />
        <Input
          size="sm"
          type="number"
          value={Math.round(cutOffset * 100) / 100}
          onChange={(event) => {
            const next = Number.parseFloat(event.target.value)
            if (Number.isFinite(next)) setCutOffset(next)
          }}
          endDecorator="mm"
          slotProps={{ input: { step: 0.1, min: Math.round(cutRange.min * 10) / 10, max: Math.round(cutRange.max * 10) / 10, 'aria-label': 'Cut plane position' } }}
          sx={{ flex: 1, minWidth: 0 }}
        />
      </Stack>
      <Slider
        size="sm"
        min={Math.round(cutRange.min * 10) / 10}
        max={Math.round(cutRange.max * 10) / 10}
        step={0.1}
        value={clampedCutOffset}
        onChange={(_event, value) => setCutOffset(value as number)}
        aria-label="Cut plane position"
      />
      {dovetail && (
        <>
          <Typography level="body-xs" textColor="text.tertiary">Joint</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
            {grooveField('Depth', groove.depth, grooveSizeLimits, (depth) => ({ ...groove, depth }))}
            {grooveField('Width', groove.width, grooveSizeLimits, (width) => ({ ...groove, width }))}
            {grooveField('Depth play', groove.depthTolerance, GROOVE_CUT_LIMITS.tolerance,
              (depthTolerance) => ({ ...groove, depthTolerance }))}
            {grooveField('Width play', groove.widthTolerance, GROOVE_CUT_LIMITS.tolerance,
              (widthTolerance) => ({ ...groove, widthTolerance }))}
            {grooveField('Flank angle', Math.round(groove.flapsAngle * DEGREES_PER_RADIAN),
              GROOVE_CUT_LIMITS.flapsAngleDegrees,
              (degrees) => ({ ...groove, flapsAngle: degrees / DEGREES_PER_RADIAN }))}
            {grooveField('Taper', Math.round(groove.grooveAngle * DEGREES_PER_RADIAN),
              GROOVE_CUT_LIMITS.grooveAngleDegrees,
              (degrees) => ({ ...groove, grooveAngle: degrees / DEGREES_PER_RADIAN }))}
          </Box>
          {!grooveValid && (
            <Alert size="sm" color="warning" variant="soft" startDecorator={<WarningRoundedIcon />}>
              <Typography level="body-xs">
                These flanks close before they reach the top. Widen the groove or reduce the flank angle.
              </Typography>
            </Alert>
          )}
        </>
      )}
      {!dovetail && (
        <>
          <Stack direction="row" spacing={0.75} alignItems="center" justifyContent="space-between">
            <Typography level="body-xs" textColor="text.tertiary">
              {connectorCount === 0 ? 'Connectors' : `Connectors (${connectorCount})`}
            </Typography>
            {connectorCount > 0 && (
              <Button size="sm" variant="plain" color="neutral" onClick={clearConnectors} sx={{ minHeight: 0, py: 0.25 }}>
                Remove all
              </Button>
            )}
          </Stack>
          <Button
            size="sm"
            variant={connectorMode ? 'solid' : 'soft'}
            color={connectorMode ? 'primary' : 'neutral'}
            onClick={() => setConnectorMode(!connectorMode)}
          >
            {connectorMode ? 'Done placing' : 'Place connectors'}
          </Button>
          {connectorMode && (
            <>
              <SegmentedChoice
                fullWidth
                label="Show half"
                value={connectorFace}
                onChange={setConnectorFace}
                options={[
                  { value: 'lower', label: `Show ${sides.lower}`, hint: `Keep the ${sides.lower} half and look at its cut face` },
                  { value: 'upper', label: `Show ${sides.upper}`, hint: `Keep the ${sides.upper} half and look at its cut face` }
                ]}
              />
              <Typography level="body-xs" textColor="text.tertiary">
                Click the cut face to add one, click a connector to remove it.
              </Typography>
            </>
          )}
          {(connectorMode || connectorCount > 0) && (
            <>
              <SegmentedChoice
                fullWidth
                label="Connector type"
                value={connectorSettings.type}
                onChange={(type) => setConnectorSettings({
                  ...connectorSettings,
                  type,
                  // Studio forces a dowel to the straight style and disables the control
                  // (`GLGizmoAdvancedCut.cpp:2861`), because its tapered form is a different solid.
                  style: type === 'dowel' ? 'prism' : connectorSettings.style
                })}
                options={CONNECTOR_TYPE_CHOICES}
              />
              {connectorSettings.type !== 'snap' && connectorSettings.type !== 'dowel' && (
                <SegmentedChoice
                  fullWidth
                  label="Connector style"
                  value={connectorSettings.style}
                  onChange={(style) => setConnectorSettings({ ...connectorSettings, style })}
                  options={CONNECTOR_STYLE_CHOICES}
                />
              )}
              {connectorSettings.type !== 'snap' && (
                <SegmentedChoice
                  fullWidth
                  label="Connector shape"
                  value={connectorSettings.shape}
                  onChange={(shape) => setConnectorSettings({ ...connectorSettings, shape })}
                  options={CONNECTOR_SHAPE_CHOICES}
                />
              )}
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
                <NumberField
                  label="Size"
                  value={Math.round(connectorSettings.radius * 200) / 100}
                  limits={connectorSizeLimits}
                  onChange={(size) => setConnectorSettings({ ...connectorSettings, radius: size / 2 })}
                />
                <NumberField
                  label="Depth"
                  value={connectorSettings.height}
                  limits={connectorSizeLimits}
                  onChange={(height) => setConnectorSettings({ ...connectorSettings, height })}
                />
                <NumberField
                  label="Size play"
                  value={connectorSettings.radiusTolerance}
                  limits={CONNECTOR_TOLERANCE_LIMITS}
                  onChange={(radiusTolerance) => setConnectorSettings({ ...connectorSettings, radiusTolerance })}
                />
                <NumberField
                  label="Depth play"
                  value={connectorSettings.heightTolerance}
                  limits={CONNECTOR_TOLERANCE_LIMITS}
                  onChange={(heightTolerance) => setConnectorSettings({ ...connectorSettings, heightTolerance })}
                />
              </Box>
            </>
          )}
          {connectorWarning && (
            <Alert size="sm" color="warning" variant="soft" startDecorator={<WarningRoundedIcon />}>
              <Typography level="body-xs">Invalid connectors: {connectorWarning}.</Typography>
            </Alert>
          )}
        </>
      )}
      <Stack direction="row" spacing={1.5}>
        <Checkbox
          size="sm"
          label={`Keep ${sides.lower}`}
          checked={cutKeepLower}
          onChange={(event) => setCutKeepLower(event.target.checked)}
        />
        <Checkbox
          size="sm"
          label={`Keep ${sides.upper}`}
          checked={cutKeepUpper}
          onChange={(event) => setCutKeepUpper(event.target.checked)}
        />
      </Stack>
      {(cutKeepLower || cutKeepUpper) && (
        <>
          <Typography level="body-xs" textColor="text.tertiary">After cut</Typography>
          {orientationRow(cutKeepLower, sides.lower, cutOrientLower, setCutOrientLower)}
          {orientationRow(cutKeepUpper, sides.upper, cutOrientUpper, setCutOrientUpper)}
        </>
      )}
      <Stack direction="row" spacing={0.75} justifyContent="flex-end">
        <Button size="sm" variant="plain" color="neutral" disabled={cutting} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          startDecorator={<ContentCutRoundedIcon />}
          loading={cutting}
          disabled={(!cutKeepLower && !cutKeepUpper) || !grooveValid || connectorWarning !== null}
          onClick={onCut}
        >
          Cut
        </Button>
      </Stack>
    </Sheet>
  )
}
