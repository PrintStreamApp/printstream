/**
 * Per-COPY deselection for printing a pre-sliced plate (used by PrintModal,
 * StoragePrintModal, and the print-queue's QueueItemDialog).
 *
 * A row is one placement on the plate, not one model: a plate holding eight copies of three
 * models offers eight checkboxes. This used to render one row per object, so every copy of a
 * duplicated or linked object collapsed into a single entry: the plate looked like it held
 * fewer models than it does, and deselecting a copy would have dropped all of them. The
 * expansion rule and the two id spaces a selection resolves into live in
 * `@printstream/shared` `plate-print-units.ts`; this component only renders them.
 *
 * The deselection rides the request as `skipObjects` + `skipInstances`; the server maps both to
 * instance identify_ids against the same plates index shown here and sends them in the
 * print-start command (with a mid-print `skip_objects` fallback for firmware that ignores the
 * start-command field). Collapsed by default to keep the dialog compact; at least one copy must
 * stay selected (skipping everything is not a print).
 */
import { useState } from 'react'
import { Box, Checkbox, Sheet, Stack, Tooltip, Typography } from '@mui/joy'
import type { PlatePrintUnit } from '@printstream/shared'

interface PrintObjectsSectionProps {
  /** One entry per placement on the selected plate (see `platePrintUnits`). */
  units: PlatePrintUnit[]
  /** Unit keys the user deselected (checked = will print). */
  deselectedKeys: ReadonlySet<string>
  onToggle: (key: string, selected: boolean) => void
}

export function PrintObjectsSection({ units, deselectedKeys, onToggle }: PrintObjectsSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const selectedCount = units.reduce((count, unit) => count + (deselectedKeys.has(unit.key) ? 0 : 1), 0)
  const anyDeselected = selectedCount < units.length
  return (
    <>
      <Typography level="title-sm">Objects</Typography>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Typography level="body-sm" textColor="text.tertiary">
              {selectedCount} of {units.length} objects will print
            </Typography>
            <Typography
              level="body-sm"
              textColor="primary.softColor"
              sx={{ cursor: 'pointer', flexShrink: 0 }}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? 'Hide objects' : 'Choose objects'}
            </Typography>
          </Stack>
          {expanded && (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 0.75 }}>
              {units.map((unit) => {
                const checked = !deselectedKeys.has(unit.key)
                // Keep at least one copy selected; and a copy the file gives no firmware handle
                // for cannot be skipped at all, so it is shown (the plate does hold it) but locked,
                // with the reason, rather than allowed into a selection the printer would reject.
                const lockedReason = !unit.skippable
                  ? 'This file records no identifier for this object, so the printer cannot skip it.'
                  : checked && selectedCount === 1
                    ? 'At least one object has to print.'
                    : null
                const checkbox = (
                  <Checkbox
                    size="sm"
                    label={unit.label}
                    checked={checked}
                    disabled={lockedReason != null}
                    onChange={(event) => onToggle(unit.key, event.target.checked)}
                    sx={{ alignItems: 'flex-start', wordBreak: 'break-word', minWidth: 0 }}
                  />
                )
                return lockedReason
                  // A disabled control fires no events, so the tooltip needs a real wrapper.
                  ? <Tooltip key={unit.key} title={lockedReason}><span>{checkbox}</span></Tooltip>
                  : <Box key={unit.key}>{checkbox}</Box>
              })}
            </Box>
          )}
          {(expanded || anyDeselected) && (
            <Typography level="body-xs" textColor="text.tertiary">
              Deselected objects are skipped automatically when the print starts.
            </Typography>
          )}
        </Stack>
      </Sheet>
    </>
  )
}
