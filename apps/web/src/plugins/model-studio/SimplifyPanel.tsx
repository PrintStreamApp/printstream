/**
 * Floating controls for paint-preserving volume simplification.
 *
 * Mirrors BambuStudio's two mutually-exclusive modes and five detail stops. The triangle count is
 * the worker's live preview result, so the ratio control describes what will actually be applied.
 */
import { Button, Radio, RadioGroup, Sheet, Slider, Stack, Typography } from '@mui/joy'
import CompressRoundedIcon from '@mui/icons-material/CompressRounded'
import { ProgressSpinner } from '../../components/ProgressSpinner'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import { TOOL_PANEL_Z_INDEX } from './editorLayers'
import {
  SIMPLIFY_DETAIL_LEVELS,
  type SimplifyDetailLevel,
  type SimplifyMode
} from './lib/meshSimplify'

export interface SimplifyPanelProps {
  name: string
  sourceTriangles: number
  previewTriangles: number | null
  mode: SimplifyMode
  onModeChange: (mode: SimplifyMode) => void
  detail: SimplifyDetailLevel
  onDetailChange: (detail: SimplifyDetailLevel) => void
  ratio: number
  onRatioChange: (ratio: number) => void
  busy: boolean
  error: string | null
  onApply: () => void
  onClose: () => void
}

export function SimplifyPanel({
  name,
  sourceTriangles,
  previewTriangles,
  mode,
  onModeChange,
  detail,
  onDetailChange,
  ratio,
  onRatioChange,
  busy,
  error,
  onApply,
  onClose
}: SimplifyPanelProps) {
  const detailIndex = Math.max(0, SIMPLIFY_DETAIL_LEVELS.findIndex((entry) => entry.value === detail))
  const resultText = previewTriangles == null
    ? `${sourceTriangles.toLocaleString()} triangles`
    : `${previewTriangles.toLocaleString()} of ${sourceTriangles.toLocaleString()} triangles`

  return (
    <Stack
      spacing={1.25}
      sx={{
        position: 'absolute',
        ...TOOL_PANEL_ANCHOR,
        zIndex: TOOL_PANEL_Z_INDEX,
        p: 1.25,
        borderRadius: 'sm',
        boxShadow: 'sm',
        bgcolor: 'background.level1',
        width: 'min(300px, calc(100% - 16px))',
        maxHeight: 'calc(100% - 16px)',
        overflowY: 'auto'
      }}
    >
      <Typography level="title-sm" startDecorator={<CompressRoundedIcon />}>Simplify</Typography>
      <Stack spacing={0.25}>
        <Typography level="body-xs" textColor="text.tertiary">Mesh</Typography>
        <Typography level="body-sm" noWrap title={name}>{name}</Typography>
        <Stack direction="row" spacing={0.75} alignItems="center">
          {busy && <ProgressSpinner size="sm" />}
          <Typography level="body-xs" textColor="text.tertiary">{resultText}</Typography>
        </Stack>
      </Stack>

      <RadioGroup value={mode} onChange={(event) => onModeChange(event.target.value as SimplifyMode)}>
        <Sheet variant="soft" sx={{ borderRadius: 'sm', p: 1 }}>
          <Stack spacing={0.75}>
            <Radio size="sm" value="detail" label="Detail level" />
            <Slider
              size="sm"
              min={0}
              max={SIMPLIFY_DETAIL_LEVELS.length - 1}
              step={1}
              value={detailIndex}
              disabled={mode !== 'detail'}
              marks={SIMPLIFY_DETAIL_LEVELS.map((_entry, index) => ({ value: index }))}
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => SIMPLIFY_DETAIL_LEVELS[value]?.label ?? ''}
              onChange={(_event, value) => {
                const entry = SIMPLIFY_DETAIL_LEVELS[Array.isArray(value) ? value[0]! : value]
                if (entry) onDetailChange(entry.value)
              }}
            />
            <Typography level="body-xs" textColor="text.tertiary">
              {SIMPLIFY_DETAIL_LEVELS[detailIndex]?.label}
            </Typography>
          </Stack>
        </Sheet>
        <Sheet variant="soft" sx={{ borderRadius: 'sm', p: 1, mt: 0.75 }}>
          <Stack spacing={0.75}>
            <Radio size="sm" value="ratio" label="Decimate ratio" />
            <Slider
              size="sm"
              min={0}
              max={100}
              step={1}
              value={ratio}
              disabled={mode !== 'ratio'}
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => `${value}%`}
              onChange={(_event, value) => onRatioChange(Array.isArray(value) ? value[0]! : value)}
            />
            <Typography level="body-xs" textColor="text.tertiary">Remove {Math.round(ratio)}% of triangles</Typography>
          </Stack>
        </Sheet>
      </RadioGroup>

      {error && <Typography level="body-xs" color="danger">{error}</Typography>}
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button size="sm" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
        <Button
          size="sm"
          onClick={onApply}
          disabled={busy || previewTriangles == null || previewTriangles >= sourceTriangles || error != null}
        >
          Apply
        </Button>
      </Stack>
    </Stack>
  )
}
