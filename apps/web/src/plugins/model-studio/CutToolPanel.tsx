/**
 * Floating control panel for the editor's plane-cut tool: axis (X/Y/Z), plane position (numeric +
 * slider, clamped to the object's range), which halves to keep, what each kept half's orientation
 * becomes, and Cut/Cancel.
 *
 * Pure presentational surface: the cut state, the live cut-plane preview mesh, and the actual
 * mesh-cut execution all live in EditorView; this only renders the controls and calls back.
 */
import { Button, ButtonGroup, Checkbox, Input, Sheet, Slider, Stack, Typography } from '@mui/joy'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import { CUT_AXIS_SIDES } from './editorGeometry'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import type { CutAxis, CutHalfOrientation } from './lib/meshCut'

/** BambuStudio's per-half after-cut choices, in its own order. */
const ORIENTATION_CHOICES: ReadonlyArray<{ value: CutHalfOrientation; label: string; hint: string }> = [
  { value: 'keep', label: 'Keep', hint: 'Keep orientation' },
  { value: 'placeOnCut', label: 'On cut', hint: 'Place on cut: rest the piece on its cut face' },
  { value: 'flip', label: 'Flip', hint: 'Flip upside down' }
]

export interface CutToolPanelProps {
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
  cutAxis, setCutAxis, cutOffset, setCutOffset, cutRange, clampedCutOffset,
  cutKeepLower, setCutKeepLower, cutKeepUpper, setCutKeepUpper,
  cutOrientLower, setCutOrientLower, cutOrientUpper, setCutOrientUpper,
  cutting, onCut, onCancel
}: CutToolPanelProps) {
  const sides = CUT_AXIS_SIDES[cutAxis]
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
      <ButtonGroup size="sm" variant="soft" aria-label={`${sideLabel} half orientation`} sx={{ flex: 1, minWidth: 0 }}>
        {ORIENTATION_CHOICES.map((choice) => (
          <Button
            key={choice.value}
            title={choice.hint}
            aria-label={`${sideLabel}: ${choice.hint}`}
            aria-pressed={value === choice.value}
            variant={value === choice.value ? 'solid' : 'soft'}
            color={value === choice.value ? 'primary' : 'neutral'}
            onClick={() => onChange(choice.value)}
            sx={{ flex: 1, minWidth: 0, px: 0.5 }}
          >
            {choice.label}
          </Button>
        ))}
      </ButtonGroup>
    </Stack>
  )

  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute', ...TOOL_PANEL_ANCHOR, zIndex: (theme) => theme.zIndex.tooltip,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
        width: 'min(260px, calc(100% - 16px))',
        display: 'flex', flexDirection: 'column', gap: 0.75
      }}
    >
      <Typography level="title-sm">Cut plane</Typography>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <ButtonGroup size="sm" variant="soft" aria-label="Cut plane axis">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <Button
              key={axis}
              variant={cutAxis === axis ? 'solid' : 'soft'}
              color={cutAxis === axis ? 'primary' : 'neutral'}
              onClick={() => setCutAxis(axis)}
            >
              {axis.toUpperCase()}
            </Button>
          ))}
        </ButtonGroup>
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
          disabled={!cutKeepLower && !cutKeepUpper}
          onClick={onCut}
        >
          Cut
        </Button>
      </Stack>
    </Sheet>
  )
}
