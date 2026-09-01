/**
 * Floating control panel for the editor's mesh boolean: operation, the operand lists, whether the
 * originals survive, and Apply/Cancel.
 *
 * Mirrors BambuStudio's `GLGizmoMeshBoolean` panel: the same three operations, the same working
 * list for the commutative pair against A/B lists for difference, and the same
 * `keep_original_models` toggle. Its warning text is Studio's own, supplied by the caller from
 * `validateMeshBoolean` so one rule and one wording drive both the message and the disabled Apply.
 *
 * Pure presentational surface, like the cut panel: the operand geometry, the evaluation and the
 * staging all live in EditorView; this renders controls and calls back.
 */
import { Button, Checkbox, Sheet, Stack, ToggleButtonGroup, Typography } from '@mui/joy'
import JoinInnerRoundedIcon from '@mui/icons-material/JoinInnerRounded'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import { TOOL_PANEL_Z_INDEX } from './editorLayers'
import type { MeshBooleanLists, MeshBooleanOperation, MeshBooleanTargetMode } from './lib/meshBoolean'

/** Studio's three, in its own order (`MeshBooleanOperation`). */
const OPERATIONS: ReadonlyArray<{ value: MeshBooleanOperation; label: string; hint: string }> = [
  { value: 'union', label: 'Union', hint: 'Everything the shapes cover, merged into one solid' },
  { value: 'difference', label: 'Difference', hint: 'A minus B: the only operation where order matters' },
  { value: 'intersection', label: 'Intersection', hint: 'Only the volume every shape shares' }
]

export interface MeshBooleanPanelProps {
  operation: MeshBooleanOperation
  onOperationChange: (next: MeshBooleanOperation) => void
  /** Whole objects, or the volumes inside one object. Studio's two modes; only the wording differs. */
  targetMode: MeshBooleanTargetMode
  lists: MeshBooleanLists
  /** Display name per operand key, so the lists read as the sidebar does. */
  nameFor: (operand: string) => string
  /** Move an operand across the difference lists. */
  onAssign: (operand: string, target: 'a' | 'b') => void
  keepOriginals: boolean
  onKeepOriginalsChange: (next: boolean) => void
  /**
   * How many helper volumes the operands carry. Zero hides the solid-parts toggle entirely, as
   * Studio hides its own ("If there is no non-entity, do not show this checkbox").
   */
  helperVolumeCount: number
  solidPartsOnly: boolean
  onSolidPartsOnlyChange: (next: boolean) => void
  /** Studio's own wording for why this cannot run yet, or null when it can. */
  warning: string | null
  busy: boolean
  onApply: () => void
  onClose: () => void
}

export function MeshBooleanPanel({
  operation, onOperationChange, targetMode, lists, nameFor, onAssign,
  keepOriginals, onKeepOriginalsChange, helperVolumeCount, solidPartsOnly, onSolidPartsOnlyChange,
  warning, busy, onApply, onClose
}: MeshBooleanPanelProps) {
  const isDifference = operation === 'difference'
  const helperVolumeLabel = `${helperVolumeCount} helper volume${helperVolumeCount === 1 ? '' : 's'}`
  // Part mode words the lists for volumes, as Studio words its own warnings per mode: the same
  // shortfall reads differently depending on whether the user thinks they are combining models or
  // the volumes inside one.
  const isPartMode = targetMode === 'part'

  return (
    <Stack
      spacing={1}
      sx={{
        position: 'absolute', ...TOOL_PANEL_ANCHOR, zIndex: TOOL_PANEL_Z_INDEX,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm', bgcolor: 'background.level1',
        // 280px puts it with Brim ears and Variable layer height rather than out on its own: at
        // 320 it covered a phone's whole viewport, and this panel is about judging how two shapes
        // overlap, which needs them visible. The list heights below carry the rest of that.
        width: 'min(280px, calc(100% - 16px))', maxHeight: 'calc(100% - 16px)', overflowY: 'auto'
      }}
    >
      <Typography level="title-sm" startDecorator={<JoinInnerRoundedIcon />}>Boolean</Typography>

      <ToggleButtonGroup
        size="sm"
        value={operation}
        onChange={(_event, next) => { if (next) onOperationChange(next) }}
      >
        {OPERATIONS.map((entry) => (
          <Button key={entry.value} value={entry.value} title={entry.hint} sx={{ flex: 1 }}>
            {entry.label}
          </Button>
        ))}
      </ToggleButtonGroup>
      <Typography level="body-xs" textColor="text.tertiary">
        {OPERATIONS.find((entry) => entry.value === operation)?.hint}
      </Typography>

      {isDifference ? (
        // Two lists, because difference is the one operation whose answer depends on which side an
        // operand is on. Each row moves with its own control rather than by dragging: the sidebar's
        // drag already means reordering, and a second drag meaning something else in the same
        // session reads as the same gesture doing two things.
        <Stack spacing={0.75}>
          <OperandList
            title="Keep (A)"
            hint="The solid being cut into."
            operands={lists.a}
            nameFor={nameFor}
            moveLabel="Move to B"
            onMove={(operand) => onAssign(operand, 'b')}
          />
          <OperandList
            title="Subtract (B)"
            hint="Removed from A."
            operands={lists.b}
            nameFor={nameFor}
            moveLabel="Move to A"
            onMove={(operand) => onAssign(operand, 'a')}
          />
        </Stack>
      ) : (
        <OperandList
          title={isPartMode ? 'Parts' : 'Objects'}
          hint={operation === 'union' ? 'All merged into one.' : 'Only what they all share is kept.'}
          operands={lists.working}
          nameFor={nameFor}
        />
      )}

      <Checkbox
        size="sm"
        label="Keep the originals"
        checked={keepOriginals}
        onChange={(event) => onKeepOriginalsChange(event.target.checked)}
        slotProps={{ label: { sx: { fontSize: 'sm' } } }}
      />
      {isDifference && keepOriginals && (
        // Difference consumes A whatever this says, so the checkbox alone would read as a promise
        // it does not keep. Studio has the same rule and says nothing about it.
        <Typography level="body-xs" textColor="text.tertiary">
          {lists.a.length > 0 ? `${nameFor(lists.a[0]!)} still becomes the result; this keeps what it is cut with.` : 'This keeps what A is cut with; A itself becomes the result.'}
        </Typography>
      )}

      {helperVolumeCount > 0 && (
        <Stack spacing={0.25}>
          <Checkbox
            size="sm"
            label="Solid parts only"
            checked={solidPartsOnly}
            onChange={(event) => onSolidPartsOnlyChange(event.target.checked)}
            slotProps={{ label: { sx: { fontSize: 'sm' } } }}
          />
          <Typography level="body-xs" textColor="text.tertiary">
            {/*
              The same toggle, but the two modes do different things with what it excludes: in object
              mode the volumes MOVE onto the result, in part mode they were never going anywhere --
              they stay on the object beside the new part, exactly as Studio leaves them.
            */}
            {!solidPartsOnly
              ? `${helperVolumeLabel} ${helperVolumeCount === 1 ? 'is' : 'are'} treated as solid and merged into the result.`
              // Where they END UP is not decided by this toggle alone: nothing is re-homed when the
              // sources survive (they keep their own volumes), and a difference carries only A's.
              // Saying "move to the result" in those cases described something that never happens.
              : isPartMode || keepOriginals
                ? `${helperVolumeLabel} ${helperVolumeCount === 1 ? 'is' : 'are'} left where ${helperVolumeCount === 1 ? 'it is' : 'they are'} rather than combined.`
                : `${helperVolumeLabel} ${helperVolumeCount === 1 ? 'moves' : 'move'} to the result instead of being merged into it.`}
          </Typography>
        </Stack>
      )}

      {warning && (
        <Typography level="body-xs" color="warning">{warning}</Typography>
      )}

      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button size="sm" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={onApply} disabled={warning != null} loading={busy}>Apply</Button>
      </Stack>
    </Stack>
  )
}

/** One operand list. `onMove` is absent for the working list, which has nowhere to move to. */
function OperandList({ title, hint, operands, nameFor, moveLabel, onMove }: {
  title: string
  /**
   * Hidden below `sm`. Not an afterthought: difference stacks TWO of these on a phone and the panel
   * has to leave the models it is combining visible, and the hint is the one line here that repeats
   * something already on screen -- "Keep (A)" / "Subtract (B)" name the sides, and the operation
   * hint right above spells out "A minus B". The list itself, the names and every control stay.
   */
  hint: string
  operands: readonly string[]
  nameFor: (operand: string) => string
  moveLabel?: string
  onMove?: (operand: string) => void
}) {
  return (
    <Stack spacing={0.25}>
      <Typography level="body-xs" fontWeight="lg">{title}</Typography>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ display: { xs: 'none', sm: 'block' } }}>
        {hint}
      </Typography>
      {/*
        Shorter on a phone, where difference stacks TWO of these and the panel is measured against a
        ~340px viewport: at a flat 116 the whole panel scrolled internally and blanketed the models
        it exists to combine. Each list still scrolls, so a long selection is reachable either way.
      */}
      <Sheet variant="soft" sx={{ borderRadius: 'sm', p: 0.5, maxHeight: { xs: 58, sm: 116 }, overflowY: 'auto' }}>
        {operands.length === 0 ? (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 0.5, py: 0.25 }}>
            Nothing here yet.
          </Typography>
        ) : operands.map((operand) => (
          <Stack
            key={operand}
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ px: 0.5, py: 0.25, minWidth: 0 }}
          >
            <Typography level="body-xs" noWrap sx={{ flex: 1, minWidth: 0 }} title={nameFor(operand)}>
              {nameFor(operand)}
            </Typography>
            {onMove && moveLabel && (
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                sx={{ minHeight: 0, py: 0.125 }}
                onClick={() => onMove(operand)}
              >
                {moveLabel}
              </Button>
            )}
          </Stack>
        ))}
      </Sheet>
    </Stack>
  )
}
