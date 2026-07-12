/**
 * Per-object deselection for printing a pre-sliced plate (used by PrintModal,
 * StoragePrintModal, and the print-queue's QueueItemDialog).
 *
 * Deselected objects ride the request as `skipObjects`; the server maps them to
 * instance identify_ids and sends them in the print-start command (with a
 * mid-print `skip_objects` fallback for firmware that ignores the start-command
 * field). Collapsed by default to keep the dialog compact; at least one object
 * must stay selected (skipping everything is not a print).
 */
import { useState } from 'react'
import { Box, Checkbox, Sheet, Stack, Typography } from '@mui/joy'
import type { ThreeMfPlateObject } from '@printstream/shared'

interface PrintObjectsSectionProps {
  /** Objects on the selected pre-sliced plate (plates index `objects`). */
  objects: ThreeMfPlateObject[]
  /** Object ids the user deselected (checked = will print). */
  deselectedIds: ReadonlySet<number>
  onToggle: (objectId: number, selected: boolean) => void
}

export function PrintObjectsSection({ objects, deselectedIds, onToggle }: PrintObjectsSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const selectedCount = objects.reduce((count, object) => count + (deselectedIds.has(object.id) ? 0 : 1), 0)
  const anyDeselected = selectedCount < objects.length
  return (
    <>
      <Typography level="title-sm">Objects</Typography>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Typography level="body-sm" textColor="text.tertiary">
              {selectedCount} of {objects.length} objects will print
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
              {objects.map((object) => {
                const checked = !deselectedIds.has(object.id)
                return (
                  <Checkbox
                    key={object.id}
                    size="sm"
                    label={object.name}
                    checked={checked}
                    // Keep at least one object selected.
                    disabled={checked && selectedCount === 1}
                    onChange={(event) => onToggle(object.id, event.target.checked)}
                    sx={{ alignItems: 'flex-start', wordBreak: 'break-word', minWidth: 0 }}
                  />
                )
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
