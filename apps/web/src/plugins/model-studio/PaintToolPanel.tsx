/**
 * Floating control panel for the editor's triangle-paint tools (support / seam / colour).
 *
 * Pure presentational surface driven by the {@link EditorPaint} controller: it renders the brush
 * mode (enforce/block/erase), the per-channel tool picker, the colour-paint material select, and the
 * tool's parameter (brush radius / smart-fill angle / height band / overhang angle) plus the
 * channel-specific hint and Clear/Done. All paint state and mutations live in `useEditorPaint`; this
 * component only reads the controller and the filament list. Visibility (which channel shows when) is
 * gated by the caller.
 */
import { Button, ButtonGroup, Checkbox, Chip, Option, Select, Sheet, Slider, Stack, Typography } from '@mui/joy'
import { PAINT_TOOL_LABELS, PAINT_TOOLS_BY_CHANNEL } from './editorGeometry'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import { FilamentOptionContent, type FilamentOption } from '../../components/library/PlateGcodeSections'
import type { EditorPaint } from './useEditorPaint'

export interface PaintToolPanelProps {
  paint: EditorPaint
  /** Painting is only supported on in-project objects (not imported meshes). */
  /** Whether the selection can be painted at all — false only with nothing selected. */
  paintTargetIsObject: boolean
  filamentOptions: FilamentOption[]
  /** Leave the paint tool (returns to the move gizmo). */
  onDone: () => void
}

export function PaintToolPanel({ paint, paintTargetIsObject, filamentOptions, onDone }: PaintToolPanelProps) {
  const {
    activePaintChannel, activePaintTool, paintBrushMode, setPaintBrushMode, setPaintTool,
    paintColorFilamentId, setPaintColorFilamentId, paintBrushRadius, setPaintBrushRadius,
    paintSmartAngle, setPaintSmartAngle, paintHeightRange, setPaintHeightRange,
    paintEdgeDetection, setPaintEdgeDetection, paintOnOverhangs, setPaintOnOverhangs,
    paintOverhangAngle, setPaintOverhangAngle, clearSelectedPaint
  } = paint
  if (activePaintChannel === null) return null
  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute', ...TOOL_PANEL_ANCHOR, zIndex: (theme) => theme.zIndex.tooltip,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
        width: 'min(280px, calc(100% - 16px))',
        display: 'flex', flexDirection: 'column', gap: 0.75
      }}
    >
      <Typography level="title-sm">
        {activePaintChannel === 'seam' ? 'Paint seam' : activePaintChannel === 'color' ? 'Paint color' : 'Paint supports'}
      </Typography>
      {!paintTargetIsObject ? (
        <Typography level="body-xs" textColor="text.tertiary">
          Select a model to paint.
        </Typography>
      ) : (
        <>
          <ButtonGroup size="sm" variant="soft" aria-label="Paint brush mode" buttonFlex={1} sx={{ width: '100%' }}>
            {activePaintChannel !== 'color' ? (
              <Button
                variant={paintBrushMode === 'enforcer' ? 'solid' : 'soft'}
                color={paintBrushMode === 'enforcer' ? 'primary' : 'neutral'}
                onClick={() => setPaintBrushMode('enforcer')}
              >
                Enforce
              </Button>
            ) : (
              <Button
                variant={paintBrushMode !== 'eraser' ? 'solid' : 'soft'}
                color={paintBrushMode !== 'eraser' ? 'primary' : 'neutral'}
                onClick={() => setPaintBrushMode('enforcer')}
              >
                Paint
              </Button>
            )}
            {activePaintChannel !== 'color' && (
              <Button
                variant={paintBrushMode === 'blocker' ? 'solid' : 'soft'}
                color={paintBrushMode === 'blocker' ? 'danger' : 'neutral'}
                onClick={() => setPaintBrushMode('blocker')}
              >
                Block
              </Button>
            )}
            <Button
              variant={paintBrushMode === 'eraser' ? 'solid' : 'soft'}
              color={paintBrushMode === 'eraser' ? 'primary' : 'neutral'}
              onClick={() => setPaintBrushMode('eraser')}
            >
              Erase
            </Button>
          </ButtonGroup>
          {PAINT_TOOLS_BY_CHANNEL[activePaintChannel].length > 1 && (
            <ButtonGroup size="sm" variant="soft" aria-label="Paint tool" buttonFlex={1} sx={{ width: '100%' }}>
              {PAINT_TOOLS_BY_CHANNEL[activePaintChannel].map((tool) => (
                <Button
                  key={tool}
                  variant={activePaintTool === tool ? 'solid' : 'soft'}
                  color={activePaintTool === tool ? 'primary' : 'neutral'}
                  onClick={() => setPaintTool(tool)}
                  sx={{ px: 0.5, fontSize: 'xs' }}
                >
                  {PAINT_TOOL_LABELS[tool]}
                </Button>
              ))}
            </ButtonGroup>
          )}
          {activePaintChannel === 'color' && (
            <Select<number>
              size="sm"
              value={paintColorFilamentId ?? filamentOptions[0]?.id ?? null}
              onChange={(_event, value) => { if (value != null) setPaintColorFilamentId(value) }}
              aria-label="Paint material"
              renderValue={(selected) => {
                const option = filamentOptions.find((entry) => entry.id === selected?.value)
                return option ? <FilamentOptionContent option={option} /> : null
              }}
            >
              {filamentOptions.map((option) => (
                <Option key={option.id} value={option.id}>
                  <FilamentOptionContent option={option} />
                </Option>
              ))}
            </Select>
          )}
          {(activePaintTool === 'circle' || activePaintTool === 'sphere') && (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Brush</Typography>
              <Slider
                size="sm"
                min={0.5}
                max={10}
                step={0.5}
                value={paintBrushRadius}
                onChange={(_event, value) => setPaintBrushRadius(value as number)}
                aria-label="Brush size"
                sx={{ flex: 1, minWidth: 0 }}
              />
              <Chip size="sm" variant="soft" color="neutral">{paintBrushRadius} mm</Chip>
            </Stack>
          )}
          {activePaintTool === 'fill' && (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Angle</Typography>
              <Slider
                size="sm"
                min={1}
                max={90}
                step={1}
                value={paintSmartAngle}
                onChange={(_event, value) => setPaintSmartAngle(value as number)}
                aria-label="Smart fill angle"
                sx={{ flex: 1, minWidth: 0 }}
              />
              <Chip size="sm" variant="soft" color="neutral">{paintSmartAngle}&deg;</Chip>
            </Stack>
          )}
          {activePaintTool === 'height' && (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Height</Typography>
              <Slider
                size="sm"
                min={0.2}
                max={10}
                step={0.2}
                value={paintHeightRange}
                onChange={(_event, value) => setPaintHeightRange(value as number)}
                aria-label="Height range"
                sx={{ flex: 1, minWidth: 0 }}
              />
              <Chip size="sm" variant="soft" color="neutral">{paintHeightRange} mm</Chip>
            </Stack>
          )}
          {activePaintChannel === 'color' && (activePaintTool === 'circle' || activePaintTool === 'sphere') && (
            <Checkbox
              size="sm"
              label="Edge detection"
              checked={paintEdgeDetection}
              onChange={(event) => setPaintEdgeDetection(event.target.checked)}
            />
          )}
          {activePaintChannel === 'supports' && (
            <Checkbox
              size="sm"
              label="On overhangs only"
              checked={paintOnOverhangs}
              onChange={(event) => setPaintOnOverhangs(event.target.checked)}
            />
          )}
          {activePaintChannel === 'supports' && paintOnOverhangs && (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Overhang</Typography>
              <Slider
                size="sm"
                min={1}
                max={90}
                step={1}
                value={paintOverhangAngle}
                onChange={(_event, value) => setPaintOverhangAngle(value as number)}
                aria-label="Overhang angle"
                sx={{ flex: 1, minWidth: 0 }}
              />
              <Chip size="sm" variant="soft" color="neutral">{paintOverhangAngle}&deg;</Chip>
            </Stack>
          )}
          <Typography level="body-xs" textColor="text.tertiary">
            {activePaintTool === 'fill'
              ? 'Click a face to fill connected faces, stopping at edges sharper than the angle.'
              : activePaintTool === 'bucket'
                ? 'Click to repaint the connected area that shares the clicked color.'
                : activePaintTool === 'triangle'
                  ? 'Click or drag to paint individual triangles.'
                  : activePaintTool === 'height'
                    ? 'Click the model to paint a horizontal band upward from the clicked height.'
                    : activePaintChannel === 'seam'
                      ? 'Drag on the model: green forces the seam here, orange keeps it away.'
                      : activePaintChannel === 'color'
                        ? 'Drag on the model to paint it with the selected material.'
                        : 'Drag on the model: blue areas force supports, red areas block them.'}
          </Typography>
          <Stack direction="row" spacing={0.75} justifyContent="space-between">
            <Button size="sm" variant="plain" color="danger" onClick={clearSelectedPaint}>
              Clear all
            </Button>
            <Button size="sm" onClick={onDone}>Done</Button>
          </Stack>
        </>
      )}
    </Sheet>
  )
}
