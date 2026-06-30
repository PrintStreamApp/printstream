/**
 * Print-queue view: the shared, reorderable backlog. Shows each queued item with a
 * live eligibility badge (recomputed from the WS-fed printer-status cache via the
 * shared matcher), and drives the manual dispatch actions — single "Start now",
 * "Start all idle", hold/resume, re-queue, reorder, and remove.
 */
import { useMemo, useState } from 'react'
import { Alert, Button, Sheet, Stack, Typography } from '@mui/joy'
import AddRounded from '@mui/icons-material/AddRounded'
import PlaylistPlayRounded from '@mui/icons-material/PlaylistPlayRounded'
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded'
import {
  JOBS_VIEW_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  isDirectPrintableFileName,
  type LibraryFile,
  type Permission,
  type Printer,
  type PrinterStatus,
  type QueueItem
} from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { EmptyState } from '../../components/EmptyState'
import { toast } from '../../lib/toast'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import {
  useDispatchAll,
  useDispatchQueueItem,
  useDryRunQueueItem,
  useQueueItemsQuery,
  useQueueSettingsQuery,
  useRemoveQueueItem,
  useReorderQueue,
  useRequeueItem,
  useUpdateQueueItem
} from './api'
import { LibraryFilePickerDialog } from '../../components/LibraryFilePickerDialog'
import { PaginatedSection } from '../../components/PaginationFooter'
import { QueueItemDialog } from './QueueItemDialog'
import { QueueStartDialog } from './QueueStartDialog'
import { SliceToQueueFlow } from './SliceToQueueFlow'
import { QueueDirectoryToolbar } from './QueueDirectoryToolbar'
import { useQueueDirectory } from './useQueueDirectory'
import { buildPrinterContexts, printerNameById, summarizeItemEligibility } from './eligibility'
import { fleetAspectState, matchPrinterAspects } from './printerAspectMatch'
import { QueueItemCard, type QueueItemFleetMatch } from './QueueItemCard'

const UNKNOWN_FLEET_MATCH: QueueItemFleetMatch = { model: 'unknown', nozzle: 'unknown', plate: 'unknown' }

export function QueueView() {
  const authBootstrapQuery = useAuthBootstrapQuery()
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const permissions = authBootstrapQuery.data?.permissions ?? []
  const hasPermission = (permission: Permission) => !authEnabled || permissions.includes(permission)
  const canView = hasPermission(JOBS_VIEW_PERMISSION) && hasPermission(LIBRARY_VIEW_PERMISSION)
  const canManage = hasPermission(PRINTS_DISPATCH_PERMISSION) && hasPermission(PRINTERS_VIEW_PERMISSION)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [addFile, setAddFile] = useState<LibraryFile | null>(null)
  const [sliceFile, setSliceFile] = useState<LibraryFile | null>(null)
  const [editingItem, setEditingItem] = useState<QueueItem | null>(null)
  const [startingItem, setStartingItem] = useState<QueueItem | null>(null)
  const [pendingItemId, setPendingItemId] = useState<string | null>(null)

  // Picking a printable file opens the rich config dialog; an unsliced project 3MF
  // runs the slice-then-queue flow on the sliced output.
  const handlePickFile = (file: LibraryFile) => {
    setPickerOpen(false)
    if (isDirectPrintableFileName(file.name)) setAddFile(file)
    else setSliceFile(file)
  }

  const itemsQuery = useQueueItemsQuery(authBootstrapQuery.isSuccess ? canView : false)
  const settingsQuery = useQueueSettingsQuery(authBootstrapQuery.isSuccess ? canView : false)
  const printersQuery = useQuery<{ printers: Printer[] }>({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal }),
    enabled: authBootstrapQuery.isSuccess ? canView : false
  })

  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const printerStatusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  const dispatchItem = useDispatchQueueItem()
  const dryRunItem = useDryRunQueueItem()
  const dispatchAll = useDispatchAll()
  const updateItem = useUpdateQueueItem()
  const requeueItem = useRequeueItem()
  const removeItem = useRemoveQueueItem()
  const reorderQueue = useReorderQueue()

  const printers = useMemo(() => printersQuery.data?.printers ?? [], [printersQuery.data])
  const items = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data])
  const directory = useQueueDirectory(items)
  const allowTypeOnlyMatch = settingsQuery.data?.settings.allowTypeOnlyMatch ?? false

  const contexts = useMemo(
    () => buildPrinterContexts(printers, printerStatusQuery.data ?? {}),
    [printers, printerStatusQuery.data]
  )

  const summaries = useMemo(
    () => new Map(items.map((item) => [item.id, summarizeItemEligibility(item, contexts, allowTypeOnlyMatch)])),
    [items, contexts, allowTypeOnlyMatch]
  )

  // Fleet-level match per item — does any connected printer satisfy the model / nozzle requirement — for
  // the card's match chips. (Material is already conveyed by the swatches + eligibility badge.)
  const fleetMatchById = useMemo(() => {
    const statuses = printerStatusQuery.data ?? {}
    const connected = printers.filter((printer) => statuses[printer.id])
    return new Map<string, QueueItemFleetMatch>(items.map((item) => {
      const matches = connected.map((printer) => matchPrinterAspects(item, printer, statuses[printer.id], allowTypeOnlyMatch))
      return [item.id, {
        model: fleetAspectState(matches, 'model'),
        nozzle: fleetAspectState(matches, 'nozzle'),
        plate: fleetAspectState(matches, 'plate')
      }]
    }))
  }, [items, printers, printerStatusQuery.data, allowTypeOnlyMatch])

  const reorderableIds = useMemo(
    () => items.filter((item) => item.status === 'queued' || item.status === 'held').map((item) => item.id),
    [items]
  )

  const idleEligibleCount = useMemo(() => {
    let count = 0
    for (const item of items) {
      if (item.status !== 'queued') continue
      if ((summaries.get(item.id)?.idlePrinterIds.length ?? 0) > 0) count += 1
    }
    return count
  }, [items, summaries])

  if (!canView) {
    return (
      <Alert color="warning" variant="soft">
        You do not have permission to view the print queue.
      </Alert>
    )
  }

  const runMutation = async (itemId: string, action: () => Promise<unknown>, errorMessage: string) => {
    setPendingItemId(itemId)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : errorMessage)
    } finally {
      setPendingItemId(null)
    }
  }

  const move = async (itemId: string, direction: -1 | 1) => {
    const index = reorderableIds.indexOf(itemId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= reorderableIds.length) return
    const next = [...reorderableIds]
    ;[next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!]
    await runMutation(itemId, () => reorderQueue.mutateAsync(next), 'Could not reorder the queue')
  }

  const handleStart = async (printerId: string, amsMapping: number[]) => {
    if (!startingItem) return
    const id = startingItem.id
    setPendingItemId(id)
    try {
      await dispatchItem.mutateAsync({ id, printerId, amsMapping })
      setStartingItem(null)
      toast.success('Print started')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start the print')
    } finally {
      setPendingItemId(null)
    }
  }

  const handleCheck = async (item: QueueItem) => {
    setPendingItemId(item.id)
    try {
      const result = await dryRunItem.mutateAsync(item.id)
      if (result.ok) {
        toast.success(result.printerName ? `Ready — would start on ${result.printerName}` : 'Ready to start')
      } else {
        toast.error(`Start would fail: ${result.reason ?? 'unknown reason'}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not run the check')
    } finally {
      setPendingItemId(null)
    }
  }

  const handleDispatchAll = async () => {
    try {
      const result = await dispatchAll.mutateAsync()
      const count = result.dispatched.length
      toast.success(count > 0 ? `Started ${count} print${count === 1 ? '' : 's'}` : 'No idle printer matched a queued job')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start idle printers')
    }
  }

  const renderCard = (item: QueueItem) => {
    const summary = summaries.get(item.id)
    if (!summary) return null
    const reorderIndex = reorderableIds.indexOf(item.id)
    const recommendedName = item.status === 'printing'
      ? printerNameById(contexts, item.lastPrinterId)
      : printerNameById(contexts, summary.recommendedPrinterId)
    return (
      <QueueItemCard
        key={item.id}
        item={item}
        summary={summary}
        fleetMatch={fleetMatchById.get(item.id) ?? UNKNOWN_FLEET_MATCH}
        recommendedName={recommendedName}
        canManage={canManage}
        busy={pendingItemId === item.id}
        isFirst={reorderIndex <= 0}
        isLast={reorderIndex === reorderableIds.length - 1}
        onStart={() => setStartingItem(item)}
        onCheck={() => handleCheck(item)}
        onHold={() => runMutation(item.id, () => updateItem.mutateAsync({ id: item.id, input: { status: 'held' } }), 'Could not hold the item')}
        onResume={() => runMutation(item.id, () => updateItem.mutateAsync({ id: item.id, input: { status: 'queued' } }), 'Could not resume the item')}
        onRequeue={() => runMutation(item.id, () => requeueItem.mutateAsync(item.id), 'Could not re-queue the item')}
        onRemove={() => runMutation(item.id, () => removeItem.mutateAsync(item.id), 'Could not remove the item')}
        onEdit={() => setEditingItem(item)}
        onMoveUp={() => move(item.id, -1)}
        onMoveDown={() => move(item.id, 1)}
      />
    )
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between" sx={{ flexWrap: 'wrap' }}>
        <Typography level="h3" startDecorator={<PlaylistPlayRounded />}>Print queue</Typography>
        {canManage ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<PlayArrowRounded />}
              loading={dispatchAll.isPending}
              disabled={idleEligibleCount === 0}
              onClick={handleDispatchAll}
            >
              {idleEligibleCount > 0 ? `Start all idle (${idleEligibleCount})` : 'Start all idle'}
            </Button>
            <Button size="sm" startDecorator={<AddRounded />} onClick={() => setPickerOpen(true)}>
              Add to queue
            </Button>
          </Stack>
        ) : null}
      </Stack>

      {items.length === 0 ? (
        <Sheet variant="soft" sx={{ borderRadius: 'md', p: 2 }}>
          <EmptyState
            icon={<PlaylistPlayRounded />}
            title="The queue is empty"
            description={canManage ? 'Add a printable library file to line up prints across your printers.' : 'No prints are queued right now.'}
            action={canManage ? <Button size="sm" startDecorator={<AddRounded />} onClick={() => setPickerOpen(true)}>Add to queue</Button> : undefined}
          />
        </Sheet>
      ) : (
        <>
          <QueueDirectoryToolbar directory={directory} />
          {directory.total === 0 ? (
            <Sheet variant="soft" sx={{ borderRadius: 'md', p: 2 }}>
              <EmptyState icon={<PlaylistPlayRounded />} title="No matching items" description="Try adjusting your search or status filter." compact />
            </Sheet>
          ) : directory.grouped ? (
            <Stack spacing={1.5}>
              {directory.groups.map((group) => (
                <Stack key={group.key} spacing={0.75}>
                  <Typography level="title-sm" textColor="text.tertiary">{group.label} · {group.items.length}</Typography>
                  <Stack spacing={1}>{group.items.map(renderCard)}</Stack>
                </Stack>
              ))}
            </Stack>
          ) : (
            <PaginatedSection
              showingLabel={`Showing ${directory.start + 1}–${Math.min(directory.start + directory.pageSize, directory.total)} of ${directory.total}`}
              previousDisabled={directory.page <= 1}
              nextDisabled={directory.start + directory.pageSize >= directory.total}
              onPrevious={() => directory.setPage((current) => Math.max(1, current - 1))}
              onNext={() => directory.setPage((current) => current + 1)}
            >
              <Stack spacing={1}>{directory.pageItems.map(renderCard)}</Stack>
            </PaginatedSection>
          )}
        </>
      )}

      {pickerOpen ? (
        <LibraryFilePickerDialog
          title="Add to queue"
          description="Choose a sliced .gcode / .gcode.3mf file, or a project 3MF to slice first."
          acceptFile={(file) => isDirectPrintableFileName(file.name) || /\.3mf$/i.test(file.name)}
          onPick={handlePickFile}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {addFile ? <QueueItemDialog open onClose={() => setAddFile(null)} fixedFile={{ id: addFile.id, name: addFile.name }} /> : null}
      {sliceFile ? <SliceToQueueFlow file={sliceFile} onClose={() => setSliceFile(null)} /> : null}
      {editingItem ? <QueueItemDialog open onClose={() => setEditingItem(null)} item={editingItem} /> : null}
      {startingItem ? (
        <QueueStartDialog
          item={startingItem}
          printers={printers}
          statuses={printerStatusQuery.data ?? {}}
          allowTypeOnlyMatch={allowTypeOnlyMatch}
          busy={pendingItemId === startingItem.id}
          onStart={handleStart}
          onClose={() => setStartingItem(null)}
        />
      ) : null}
    </Stack>
  )
}
