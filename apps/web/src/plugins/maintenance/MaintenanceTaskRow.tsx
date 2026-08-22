/**
 * One maintenance task in the printer detail section: what the job is, when it
 * is next due, and the two actions on it (mark done, adjust).
 *
 * Purely presentational — mutations belong to `MaintenanceSection`, which owns
 * the query invalidation. Memoized with stable callbacks because its parent sits
 * on the printers page, which re-renders on live status.
 */
import BuildRoundedIcon from '@mui/icons-material/BuildRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { Box, Button, Chip, IconButton, Sheet, Stack, Tooltip, Typography } from '@mui/joy'
import { memo, useCallback } from 'react'
import type { MaintenanceTaskDto } from '@printstream/shared'
import {
  formatDueSummary,
  formatIntervals,
  lubricantLabel,
  maintenanceStatusColor,
  maintenanceStatusLabel,
  unavailableTriggerNote
} from './maintenancePresentation'
import { ProgressBar } from '../../components/ProgressBar'

interface MaintenanceTaskRowProps {
  task: MaintenanceTaskDto
  canManage: boolean
  busy: boolean
  onComplete: (taskKey: string) => void
  onAdjust: (task: MaintenanceTaskDto) => void
}

function MaintenanceTaskRowComponent({ task, canManage, busy, onComplete, onAdjust }: MaintenanceTaskRowProps) {
  const handleComplete = useCallback(() => onComplete(task.key), [onComplete, task.key])
  const handleAdjust = useCallback(() => onAdjust(task), [onAdjust, task])

  const color = maintenanceStatusColor(task.status)
  const lubricant = lubricantLabel(task.lubricant)
  // Only the measured triggers can explain themselves; an untracked one says why
  // it is inert rather than silently reading as fresh.
  const notes = task.triggers.map(unavailableTriggerNote).filter((note): note is string => note != null)

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', p: 1.5, opacity: task.disabled ? 0.6 : 1 }}>
      <Stack spacing={1}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography level="title-sm">{task.title}</Typography>
              <Chip size="sm" variant="soft" color={color}>{maintenanceStatusLabel(task)}</Chip>
              {lubricant && <Chip size="sm" variant="outlined" color="neutral">{lubricant}</Chip>}
              {task.customized && (
                <Tooltip title="This interval was changed from the recommended one.">
                  <Chip size="sm" variant="outlined" color="neutral">Custom interval</Chip>
                </Tooltip>
              )}
            </Stack>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.25 }}>
              {task.summary}
            </Typography>
          </Box>

          <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
            <Button
              size="sm"
              variant={task.status === 'due' ? 'solid' : 'soft'}
              color={task.status === 'due' ? 'primary' : 'neutral'}
              startDecorator={<CheckRoundedIcon />}
              onClick={handleComplete}
              disabled={!canManage || busy}
            >
              Mark done
            </Button>
            <Tooltip title="Adjust this task">
              <span>
                <IconButton size="sm" variant="plain" color="neutral" onClick={handleAdjust} disabled={!canManage}>
                  <TuneRoundedIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography level="body-xs" textColor={task.status === 'due' ? 'danger.plainColor' : 'text.secondary'}>
            {formatDueSummary(task)}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary">·</Typography>
          <Typography level="body-xs" textColor="text.tertiary">{formatIntervals(task)}</Typography>
        </Stack>

        {task.progress != null && !task.disabled && (
          <ProgressBar
            value={task.progress * 100}
            color={color === 'neutral' ? 'neutral' : color}
            size="sm"
          />
        )}

        {task.intervalNote && (
          <Stack direction="row" spacing={0.75} alignItems="flex-start">
            {/* Never put `sx` on an @mui/icons-material icon: its sx runs through the
                Material style engine, which has no theme in this Joy-only app and
                throws at render. Style the Joy wrapper and let the icon inherit. */}
            <Box sx={{ color: 'text.tertiary', display: 'flex', mt: '2px' }}>
              <BuildRoundedIcon fontSize="small" />
            </Box>
            <Typography level="body-xs" textColor="text.tertiary">{task.intervalNote}</Typography>
          </Stack>
        )}

        {notes.map((note) => (
          <Typography key={note} level="body-xs" textColor="warning.plainColor">{note}</Typography>
        ))}
      </Stack>
    </Sheet>
  )
}

export const MaintenanceTaskRow = memo(MaintenanceTaskRowComponent)
