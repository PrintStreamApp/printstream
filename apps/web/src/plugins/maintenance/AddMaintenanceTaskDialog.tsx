/**
 * Add a maintenance task the catalog does not cover.
 *
 * This is the escape hatch that keeps a printer usable before its model reaches
 * the catalog — a machine released after this build falls back to the generic
 * schedule, and anything specific to it gets added here rather than waiting for
 * an update. It also covers a shop's own routines, which Bambu will never
 * publish.
 */
import { FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy'
import { useState } from 'react'
import type { MaintenanceCustomTaskRequest, MaintenanceLubricant } from '@printstream/shared'
import { DialogSection } from '../../components/DialogSection'
import { FormDialog } from '../../components/FormDialog'

interface AddMaintenanceTaskDialogProps {
  busy: boolean
  error: string | null
  onClose: () => void
  onCreate: (request: MaintenanceCustomTaskRequest) => void
}

function parseInterval(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function AddMaintenanceTaskDialog({ busy, error, onClose, onCreate }: AddMaintenanceTaskDialogProps) {
  const [title, setTitle] = useState('')
  const [lubricant, setLubricant] = useState<MaintenanceLubricant>('none')
  const [days, setDays] = useState('90')
  const [printHours, setPrintHours] = useState('')
  const [filamentKilograms, setFilamentKilograms] = useState('')

  const handleSubmit = () => {
    onCreate({
      title: title.trim(),
      lubricant,
      intervalDays: parseInterval(days),
      intervalPrintHours: parseInterval(printHours),
      intervalFilamentKilograms: parseInterval(filamentKilograms)
    })
  }

  return (
    <FormDialog
      onClose={onClose}
      busy={busy}
      title="Add a maintenance task"
      description="Tracked on this printer only, alongside the recommended ones."
      error={error}
      submitLabel="Add task"
      onSubmit={handleSubmit}
      submitDisabled={title.trim().length === 0}
    >
      <Stack spacing={2}>
        <DialogSection title="Task">
          <Stack spacing={1.5}>
            <FormControl required>
              <FormLabel>Name</FormLabel>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Clean the chamber fan"
                disabled={busy}
                autoFocus
              />
            </FormControl>
            <FormControl>
              <FormLabel>Lubricant</FormLabel>
              <Select
                value={lubricant}
                onChange={(_event, value) => {
                  // Joy fires onChange(null) on some interactions; a null is never a user pick.
                  if (value) setLubricant(value)
                }}
                disabled={busy}
              >
                <Option value="none">None</Option>
                <Option value="oil">Oil</Option>
                <Option value="grease">Grease</Option>
              </Select>
            </FormControl>
          </Stack>
        </DialogSection>

        <DialogSection title="Remind me" description="Leave a box empty to skip that measure. Whichever comes first makes the task due.">
          <Stack spacing={1.5}>
            <FormControl>
              <FormLabel>Every N days</FormLabel>
              <Input type="number" size="sm" slotProps={{ input: { min: 1 } }} value={days} onChange={(event) => setDays(event.target.value)} disabled={busy} />
            </FormControl>
            <FormControl>
              <FormLabel>Every N print hours</FormLabel>
              <Input type="number" size="sm" slotProps={{ input: { min: 1 } }} value={printHours} onChange={(event) => setPrintHours(event.target.value)} disabled={busy} />
            </FormControl>
            <FormControl>
              <FormLabel>Every N kilograms of filament</FormLabel>
              <Input type="number" size="sm" slotProps={{ input: { min: 1, step: 'any' } }} value={filamentKilograms} onChange={(event) => setFilamentKilograms(event.target.value)} disabled={busy} />
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>One roll is one kilogram.</Typography>
            </FormControl>
          </Stack>
        </DialogSection>
      </Stack>
    </FormDialog>
  )
}
