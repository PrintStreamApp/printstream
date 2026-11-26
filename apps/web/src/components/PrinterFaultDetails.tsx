/**
 * Shared fault count and expandable observation detail for active jobs, finished
 * jobs, and idle history cards. Gaps remain visible after reconciliation and
 * deleting history is a separate, permission-gated action that never clears a printer.
 */
import { Accordion, AccordionDetails, AccordionSummary, Button, Chip, Stack, Typography } from '@mui/joy'
import { useCallback, useState } from 'react'
import { flushSync } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage, type PrinterFault } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { formatDateTimeInZone } from '../lib/time'
import { toast } from '../lib/toast'
import { ConfirmActionDialog } from './ConfirmActionDialog'

/** Renders durable observations only; no timestamp is invented from a live status snapshot. */
export function PrinterFaultDetails({ faults, canDelete = false }: { faults: readonly PrinterFault[]; canDelete?: boolean }) {
  const [target, setTarget] = useState<PrinterFault | null>(null)
  const queryClient = useQueryClient()
  const close = useCallback(() => setTarget(null), [])
  const deletion = useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/jobs/faults/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Cleared fault deleted from history')
      // A refresh may remove the last fault's entire card. Commit open=false
      // first so BackAwareModal consumes its history entry before that unmount.
      flushSync(close)
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      void queryClient.invalidateQueries({ queryKey: ['job-history'] })
    },
    onError: (error) => toast.error(extractErrorMessage(error))
  })
  return (
    <>
      {faults.length ? <Accordion>
        <AccordionSummary>
          <Chip size="sm" variant="soft" color="warning">{faults.length} {faults.length === 1 ? 'fault' : 'faults'}</Chip>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1.5}>
            {faults.map((fault) => (
              <Stack key={fault.id} spacing={0.5}>
                <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
                  {fault.source === 'hms' ? 'HMS' : 'Device print error'}: {fault.message ?? 'Unknown printer fault'} ({fault.code})
                </Typography>
                <Typography level="body-xs">
                  {fault.alreadyPresent ? 'Already present. ' : ''}First observed {formatDateTimeInZone(fault.firstObservedAt, 'America/Toronto')}
                </Typography>
                <Typography level="body-xs">
                  {fault.observedClearedAt
                    ? `Clear observed ${formatDateTimeInZone(fault.observedClearedAt, 'America/Toronto')}`
                    : fault.state === 'uncertain' ? 'State uncertain after an observation gap.' : 'Ongoing at last observation.'}
                </Typography>
                {fault.gaps.map((gap, index) => (
                  <Typography key={`${gap.startedAt}:${index}`} level="body-xs" textColor="text.tertiary">
                    Observation gap ({gap.reason === 'restart' ? 'server restart' : 'disconnected'}): {formatDateTimeInZone(gap.startedAt, 'America/Toronto')}
                    {gap.endedAt ? ` to ${formatDateTimeInZone(gap.endedAt, 'America/Toronto')}` : ', awaiting a fresh report from this source'}
                  </Typography>
                ))}
                {canDelete && fault.state === 'cleared' ? (
                  <Button size="sm" variant="plain" color="danger" sx={{ alignSelf: 'flex-start' }} onClick={() => setTarget(fault)}>Delete fault history</Button>
                ) : null}
              </Stack>
            ))}
            <Typography level="body-xs" textColor="text.tertiary">Times are observations in Toronto time. A gap does not prove when a fault began or cleared.</Typography>
          </Stack>
        </AccordionDetails>
      </Accordion> : null}
      <ConfirmActionDialog
        open={target !== null}
        title="Delete cleared fault history?"
        description="This removes this occurrence from every job and idle history card. It does not send a command to the printer."
        confirmLabel="Delete fault history"
        pending={deletion.isPending}
        onClose={close}
        onConfirm={() => { if (target) deletion.mutate(target.id) }}
      />
    </>
  )
}
