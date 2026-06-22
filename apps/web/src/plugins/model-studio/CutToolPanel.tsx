/**
 * Floating control panel for the editor's plane-cut tool: axis (X/Y/Z), plane position (numeric +
 * slider, clamped to the object's range), which halves to keep, and Cut/Cancel.
 *
 * Pure presentational surface — the cut state, the live cut-plane preview mesh, and the actual
 * mesh-cut execution all live in EditorView; this only renders the controls and calls back.
 */
import { Button, ButtonGroup, Checkbox, Input, Sheet, Slider, Stack, Typography } from '@mui/joy'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import { CUT_AXIS_SIDES } from './editorGeometry'
import { TOOL_PANEL_TOP } from './editorPanels'
import type { CutAxis } from './lib/meshCut'

export interface CutToolPanelProps {
  cutAxis: CutAxis
  setCutAxis: (axis: CutAxis) => void
  cutOffset: number
  setCutOffset: (value: number) => void
  /** The selected object's extent along the cut axis (panel only renders when this is known). */
  cutRange: { min: number; max: number }
  /** `cutOffset` clamped into `cutRange` — what the slider/preview actually use. */
  clampedCutOffset: number
  cutKeepLower: boolean
  setCutKeepLower: (value: boolean) => void
  cutKeepUpper: boolean
  setCutKeepUpper: (value: boolean) => void
  /** A cut is running (disables inputs, shows the spinner). */
  cutting: boolean
  onCut: () => void
  onCancel: () => void
}

export function CutToolPanel({
  cutAxis, setCutAxis, cutOffset, setCutOffset, cutRange, clampedCutOffset,
  cutKeepLower, setCutKeepLower, cutKeepUpper, setCutKeepUpper, cutting, onCut, onCancel
}: CutToolPanelProps) {
  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute', top: TOOL_PANEL_TOP, left: 8, zIndex: (theme) => theme.zIndex.tooltip,
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
          label={`Keep ${CUT_AXIS_SIDES[cutAxis].lower}`}
          checked={cutKeepLower}
          onChange={(event) => setCutKeepLower(event.target.checked)}
        />
        <Checkbox
          size="sm"
          label={`Keep ${CUT_AXIS_SIDES[cutAxis].upper}`}
          checked={cutKeepUpper}
          onChange={(event) => setCutKeepUpper(event.target.checked)}
        />
      </Stack>
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
