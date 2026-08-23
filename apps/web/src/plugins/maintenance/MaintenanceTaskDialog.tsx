/**
 * Adjust one maintenance task: retime its intervals, switch it off, or (for a
 * user-defined task) rename and delete it.
 *
 * Each interval is an optional number with its own "track this" switch, because
 * the three states the wire distinguishes, inherit, set to a value, cleared,
 * cannot be expressed by an empty text field alone. Clearing every interval is
 * allowed and means the task only ever comes due if the printer asks for it.
 *
 * Catalog tasks keep their wording: the title and lubricant fields appear only
 * for custom tasks, so the same job cannot read differently on two printers.
 */
import {
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Switch,
  Typography
} from '@mui/joy'
import { useMemo, useState } from 'react'
import type { MaintenanceLubricant, MaintenanceTaskDto, MaintenanceTaskPatchRequest } from '@printstream/shared'
import { DialogSection } from '../../components/DialogSection'
import { FormDialog } from '../../components/FormDialog'
import { formatDayInterval } from './maintenancePresentation'

interface IntervalFieldState {
  enabled: boolean
  value: string
}

function toFieldState(value: number | null): IntervalFieldState {
  return { enabled: value != null, value: value != null ? String(value) : '' }
}

/**
 * Turn a field back into the wire value: `null` when switched off (an explicit
 * clear), `undefined` when unchanged, else the number.
 */
function toPatchValue(field: IntervalFieldState, original: number | null): number | null | undefined {
  if (!field.enabled) return original == null ? undefined : null
  const parsed = Number(field.value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed === original ? undefined : parsed
}

interface MaintenanceTaskDialogProps {
  task: MaintenanceTaskDto
  busy: boolean
  error: string | null
  onClose: () => void
  onSave: (patch: MaintenanceTaskPatchRequest) => void
  onReset: () => void
  onDelete: () => void
}

export function MaintenanceTaskDialog({ task, busy, error, onClose, onSave, onReset, onDelete }: MaintenanceTaskDialogProps) {
  const [days, setDays] = useState(() => toFieldState(task.intervals.days))
  const [printHours, setPrintHours] = useState(() => toFieldState(task.intervals.printHours))
  const [filamentKilograms, setFilamentKilograms] = useState(() => toFieldState(task.intervals.filamentKilograms))
  const [disabled, setDisabled] = useState(task.disabled)
  const [title, setTitle] = useState(task.title)
  const [lubricant, setLubricant] = useState<MaintenanceLubricant>(task.lubricant)

  const isCustom = task.source === 'custom'
  const recommended = useMemo(() => {
    if (isCustom) return null
    const parts: string[] = []
    if (task.catalogIntervals.days != null) parts.push(formatDayInterval(task.catalogIntervals.days).toLowerCase())
    if (task.catalogIntervals.printHours != null) parts.push(`every ${task.catalogIntervals.printHours} print hours`)
    if (task.catalogIntervals.filamentKilograms != null) parts.push(`every ${task.catalogIntervals.filamentKilograms} kg of filament`)
    return parts.length > 0 ? parts.join(', or ') : null
  }, [isCustom, task.catalogIntervals])

  const handleSubmit = () => {
    onSave({
      intervalDays: toPatchValue(days, task.intervals.days),
      intervalPrintHours: toPatchValue(printHours, task.intervals.printHours),
      intervalFilamentKilograms: toPatchValue(filamentKilograms, task.intervals.filamentKilograms),
      ...(disabled !== task.disabled ? { disabled } : {}),
      ...(isCustom && title.trim() && title !== task.title ? { title: title.trim() } : {}),
      ...(isCustom && lubricant !== task.lubricant ? { lubricant } : {})
    })
  }

  return (
    <FormDialog
      onClose={onClose}
      busy={busy}
      title={task.title}
      description={recommended ? `Bambu recommends ${recommended} for this printer.` : undefined}
      error={error}
      submitLabel="Save"
      onSubmit={handleSubmit}
    >
      <Stack spacing={2}>
        {isCustom && (
          <DialogSection title="Task">
            <Stack spacing={1.5}>
              <FormControl>
                <FormLabel>Name</FormLabel>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
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
        )}

        <DialogSection
          title="Remind me"
          description="Whichever of these comes first makes the task due."
        >
          <Stack spacing={1.5}>
            <IntervalField
              label="Every N days"
              helper="Bambu writes its intervals in months: 30 days is monthly, 90 is quarterly."
              field={days}
              onChange={setDays}
              disabled={busy}
            />
            <IntervalField
              label="Every N print hours"
              helper="Counted from this printer's lifetime print hours."
              field={printHours}
              onChange={setPrintHours}
              disabled={busy}
            />
            <IntervalField
              label="Every N kilograms of filament"
              helper="One roll is one kilogram. Needs prints that recorded filament use."
              field={filamentKilograms}
              onChange={setFilamentKilograms}
              disabled={busy}
            />
          </Stack>
        </DialogSection>

        <DialogSection title="Visibility">
          <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <FormLabel>Track this task</FormLabel>
              <FormHelperText sx={{ mt: 0 }}>
                Switched off, it never reports due and is greyed out in the list.
              </FormHelperText>
            </div>
            <Switch checked={!disabled} onChange={(event) => setDisabled(!event.target.checked)} disabled={busy} />
          </FormControl>
        </DialogSection>

        <Stack direction="row" spacing={1} justifyContent="flex-start">
          {isCustom ? (
            <Button size="sm" variant="plain" color="danger" onClick={onDelete} disabled={busy}>
              Delete task
            </Button>
          ) : (
            task.customized && (
              <Button size="sm" variant="plain" color="neutral" onClick={onReset} disabled={busy}>
                Reset to recommended
              </Button>
            )
          )}
        </Stack>
      </Stack>
    </FormDialog>
  )
}

function IntervalField({
  label,
  helper,
  field,
  onChange,
  disabled
}: {
  label: string
  helper: string
  field: IntervalFieldState
  onChange: (next: IntervalFieldState) => void
  disabled: boolean
}) {
  return (
    <FormControl>
      <Stack direction="row" spacing={1} alignItems="center">
        <Switch
          checked={field.enabled}
          onChange={(event) => onChange({ ...field, enabled: event.target.checked })}
          disabled={disabled}
        />
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <FormLabel sx={{ mb: 0.5 }}>{label}</FormLabel>
          <Input
            type="number"
            slotProps={{ input: { min: 1, step: 'any' } }}
            value={field.value}
            onChange={(event) => onChange({ ...field, value: event.target.value })}
            disabled={disabled || !field.enabled}
            size="sm"
          />
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>{helper}</Typography>
        </Stack>
      </Stack>
    </FormControl>
  )
}
