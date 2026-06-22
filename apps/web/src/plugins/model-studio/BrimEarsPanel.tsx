/**
 * Floating control panel for the editor's manual brim-ear tool: the ear diameter for newly placed
 * ears, plus Clear/Done. Presentational only — placement and the ear state live in EditorView.
 */
import { Button, Chip, Sheet, Slider, Stack, Typography } from '@mui/joy'
import { TOOL_PANEL_TOP } from './editorPanels'

export interface BrimEarsPanelProps {
  /** Brim ears are only supported on in-project objects (not imported meshes). */
  paintTargetIsObject: boolean
  brimEarDiameter: number
  setBrimEarDiameter: (value: number) => void
  onClear: () => void
  onDone: () => void
}

export function BrimEarsPanel({ paintTargetIsObject, brimEarDiameter, setBrimEarDiameter, onClear, onDone }: BrimEarsPanelProps) {
  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute', top: TOOL_PANEL_TOP, left: 8, zIndex: (theme) => theme.zIndex.tooltip,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
        width: 'min(280px, calc(100% - 16px))',
        display: 'flex', flexDirection: 'column', gap: 0.75
      }}
    >
      <Typography level="title-sm">Brim ears</Typography>
      {!paintTargetIsObject ? (
        <Typography level="body-xs" textColor="text.tertiary">
          Brim ears aren't available for imported models yet.
        </Typography>
      ) : (
        <>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Ear size</Typography>
            <Slider
              size="sm"
              min={2}
              max={20}
              step={0.5}
              value={brimEarDiameter}
              onChange={(_event, value) => setBrimEarDiameter(value as number)}
              aria-label="Brim ear diameter"
              sx={{ flex: 1, minWidth: 0 }}
            />
            <Chip size="sm" variant="soft" color="neutral">{brimEarDiameter} mm</Chip>
          </Stack>
          <Typography level="body-xs" textColor="text.tertiary">
            Click the model near the bed to add an ear; click an ear to remove it.
            Ears print only when the process Brim type is set to "Brim ears".
          </Typography>
          <Stack direction="row" spacing={0.75} justifyContent="space-between">
            <Button size="sm" variant="plain" color="danger" onClick={onClear}>
              Clear all
            </Button>
            <Button size="sm" onClick={onDone}>Done</Button>
          </Stack>
        </>
      )}
    </Sheet>
  )
}
