/**
 * The "Maintenance" section on the printer detail page, contributed to the
 * `printer.detail.sections` slot.
 *
 * Owns every maintenance mutation for one printer and the cache invalidation
 * that follows: marking a task done changes both this list and the overdue chip
 * on the printers grid, so both query keys are invalidated together — a section
 * that only refreshed itself would leave the chip stating the opposite.
 *
 * Renders `null` when the printer id is missing or the request 404s (the plugin
 * may be enabled while the printer row is gone), per the slot contract.
 *
 * Counterpart: `apps/api/src/plugins/maintenance/routes.ts`.
 */
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import BuildRoundedIcon from '@mui/icons-material/BuildRounded'
import { Alert, Button, Link, Stack, Typography } from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import {
  PRINTERS_MANAGE_PERMISSION,
  extractErrorMessage,
  type MaintenanceCustomTaskRequest,
  type MaintenanceTaskDto,
  type MaintenanceTaskPatchRequest
} from '@printstream/shared'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { PageSectionHeading } from '../../components/dashboard/PageSectionHeading'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { AddMaintenanceTaskDialog } from './AddMaintenanceTaskDialog'
import { MaintenanceTaskDialog } from './MaintenanceTaskDialog'
import { MaintenanceTaskRow } from './MaintenanceTaskRow'
import {
  completeMaintenanceTask,
  createMaintenanceTask,
  deleteMaintenanceTask,
  fetchPrinterMaintenance,
  maintenanceKeys,
  patchMaintenanceTask,
  resetMaintenanceTask,
  useMaintenanceSync
} from './api'

export function MaintenanceSection(props: Record<string, unknown>) {
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  useMaintenanceSync()
  const queryClient = useQueryClient()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const [editing, setEditing] = useState<MaintenanceTaskDto | null>(null)
  const [adding, setAdding] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const permissions = authBootstrapQuery.data?.permissions ?? []
  const canManage = authBootstrapQuery.data ? (!authEnabled || permissions.includes(PRINTERS_MANAGE_PERMISSION)) : false

  const maintenanceQuery = useQuery({
    queryKey: maintenanceKeys.printer(printerId ?? ''),
    queryFn: ({ signal }) => fetchPrinterMaintenance(printerId!, signal),
    enabled: printerId != null
  })

  // Every write moves both the section and the printers-grid chip. Invalidating
  // the whole namespace is deliberately blunt: a targeted key here would leave
  // the chip stale, which reads as the two surfaces disagreeing.
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: maintenanceKeys.all })
  }, [queryClient])

  const completeMutation = useMutation({
    mutationFn: (taskKey: string) => completeMaintenanceTask(printerId!, taskKey),
    onSuccess: invalidate,
    onError: (error) => setMutationError(extractErrorMessage(error))
  })

  const patchMutation = useMutation({
    mutationFn: ({ taskKey, patch }: { taskKey: string; patch: MaintenanceTaskPatchRequest }) =>
      patchMaintenanceTask(printerId!, taskKey, patch),
    onSuccess: () => {
      invalidate()
      setEditing(null)
      setMutationError(null)
    },
    onError: (error) => setMutationError(extractErrorMessage(error))
  })

  const resetMutation = useMutation({
    mutationFn: (taskKey: string) => resetMaintenanceTask(printerId!, taskKey),
    onSuccess: () => {
      invalidate()
      setEditing(null)
      setMutationError(null)
    },
    onError: (error) => setMutationError(extractErrorMessage(error))
  })

  const deleteMutation = useMutation({
    mutationFn: (taskKey: string) => deleteMaintenanceTask(printerId!, taskKey),
    onSuccess: () => {
      invalidate()
      setEditing(null)
      setMutationError(null)
    },
    onError: (error) => setMutationError(extractErrorMessage(error))
  })

  const createMutation = useMutation({
    mutationFn: (request: MaintenanceCustomTaskRequest) => createMaintenanceTask(printerId!, request),
    onSuccess: () => {
      invalidate()
      setAdding(false)
      setMutationError(null)
    },
    onError: (error) => setMutationError(extractErrorMessage(error))
  })

  const handleComplete = useCallback((taskKey: string) => completeMutation.mutate(taskKey), [completeMutation])
  const handleAdjust = useCallback((task: MaintenanceTaskDto) => {
    setMutationError(null)
    setEditing(task)
  }, [])
  const handleCloseEditor = useCallback(() => {
    setEditing(null)
    setMutationError(null)
  }, [])
  const handleCloseAdd = useCallback(() => {
    setAdding(false)
    setMutationError(null)
  }, [])
  const handleOpenAdd = useCallback(() => {
    setMutationError(null)
    setAdding(true)
  }, [])

  if (!printerId) return null
  if (maintenanceQuery.error) return null

  const data = maintenanceQuery.data
  const dueCount = data?.tasks.filter((task) => task.status === 'due').length ?? 0

  return (
    <Stack spacing={1.5}>
      <PageSectionHeading
        icon={<BuildRoundedIcon />}
        title="Maintenance"
        description="When this printer is next due for lubrication and the other servicing Bambu recommends."
        count={dueCount > 0 ? dueCount : undefined}
        actions={canManage ? (
          <Button size="sm" variant="soft" startDecorator={<AddRoundedIcon />} onClick={handleOpenAdd}>
            Add task
          </Button>
        ) : undefined}
      />

      {maintenanceQuery.isLoading && <ListSkeleton rows={4} />}

      {data && data.schedule.generic && (
        <Alert color="warning" variant="soft">
          <Typography level="body-sm">
            No published schedule for {data.printerModel || 'this model'} yet, so these are general intervals rather than
            Bambu's for this machine. Check{' '}
            <Link href={data.schedule.wikiUrl} target="_blank" rel="noreferrer">Bambu's maintenance guide</Link>
            {' '}and adjust them to match.
          </Typography>
        </Alert>
      )}

      {mutationError && !editing && !adding && (
        <Alert color="danger" variant="soft">{mutationError}</Alert>
      )}

      {data && data.tasks.length === 0 && (
        <EmptyState
          icon={<BuildRoundedIcon />}
          title="No maintenance tasks"
          description="Add a task to start tracking servicing for this printer."
          action={canManage ? (
            <Button size="sm" variant="soft" startDecorator={<AddRoundedIcon />} onClick={handleOpenAdd}>
              Add task
            </Button>
          ) : undefined}
        />
      )}

      {data && data.tasks.length > 0 && (
        <Stack spacing={1}>
          {data.tasks.map((task) => (
            <MaintenanceTaskRow
              key={task.key}
              task={task}
              canManage={canManage}
              busy={completeMutation.isPending}
              onComplete={handleComplete}
              onAdjust={handleAdjust}
            />
          ))}
        </Stack>
      )}

      {data && !data.schedule.generic && (
        <Typography level="body-xs" textColor="text.tertiary">
          Intervals recommended by Bambu for the {data.schedule.label}.{' '}
          <Link href={data.schedule.wikiUrl} target="_blank" rel="noreferrer">Read the maintenance guide</Link>
        </Typography>
      )}

      {editing && (
        <MaintenanceTaskDialog
          task={editing}
          busy={patchMutation.isPending || resetMutation.isPending || deleteMutation.isPending}
          error={mutationError}
          onClose={handleCloseEditor}
          onSave={(patch) => patchMutation.mutate({ taskKey: editing.key, patch })}
          onReset={() => resetMutation.mutate(editing.key)}
          onDelete={() => deleteMutation.mutate(editing.key)}
        />
      )}

      {adding && (
        <AddMaintenanceTaskDialog
          busy={createMutation.isPending}
          error={mutationError}
          onClose={handleCloseAdd}
          onCreate={(request) => createMutation.mutate(request)}
        />
      )}
    </Stack>
  )
}
