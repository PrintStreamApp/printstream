/**
 * Filament tab: a directory-style spool inventory with search, filters,
 * grouping, sort, and list/icon views. Remaining filament shows both
 * graphically (bar) and numerically. The directory controls + grouped/paginated
 * rendering are the shared spool primitives ({@link useSpoolDirectory},
 * {@link SpoolDirectoryToolbar}, {@link SpoolResults}) — the same ones the
 * AMS-slot spool picker uses, so the two stay in sync.
 *
 * Desktop adds a multi-select mode ({@link useSpoolSelection}) with a bulk action
 * bar for unloading and recycling several spools at once.
 */
import { useMemo, useState } from 'react'
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import EjectRoundedIcon from '@mui/icons-material/EjectRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import type { FilamentSpool } from '@printstream/shared'
import { extractErrorMessage } from '@printstream/shared'
import { EmptyState } from '../../components/EmptyState'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { FilamentSpoolIcon } from './FilamentSpoolIcon'
import { useSpoolsQuery, useSpoolMutations } from './api'
import { useFilamentSync } from './useFilamentSync'
import { SpoolList } from './SpoolList'
import { SpoolGrid } from './SpoolGrid'
import { SpoolFormDialog } from './SpoolFormDialog'
import { SpoolAdjustDialog } from './SpoolAdjustDialog'
import { SpoolDirectoryToolbar } from './SpoolDirectoryToolbar'
import { SpoolResults } from './SpoolResults'
import { useSpoolDirectory } from './useSpoolDirectory'
import { useSpoolSelection } from './useSpoolSelection'

export function FilamentView() {
  useFilamentSync()
  const spoolsQuery = useSpoolsQuery()
  const { recycle, unassign } = useSpoolMutations()
  const { confirm } = usePromptDialog()

  const [editing, setEditing] = useState<FilamentSpool | null>(null)
  const [creating, setCreating] = useState(false)
  const [adjusting, setAdjusting] = useState<FilamentSpool | null>(null)

  const spools = useMemo(() => spoolsQuery.data ?? [], [spoolsQuery.data])
  const directory = useSpoolDirectory(spools)
  const selection = useSpoolSelection(directory.visible)
  const summary = useMemo(() => {
    const active = spools.filter((spool) => spool.archivedAt == null)
    const remainingKg = active.reduce((sum, spool) => sum + spool.remainingGrams, 0) / 1000
    const valueCents = active.reduce((sum, spool) => (
      spool.costCents != null && spool.netWeightGrams > 0
        ? sum + spool.costCents * (spool.remainingGrams / spool.netWeightGrams)
        : sum
    ), 0)
    return { count: active.length, remainingKg, valueCents }
  }, [spools])

  const { selectedSpools, setSelectionMode, setAllSelected } = selection
  const loadedSelected = useMemo(() => selectedSpools.filter((spool) => spool.loadedPrinterId), [selectedSpools])
  const allVisibleSelected = directory.visible.length > 0 && selectedSpools.length === directory.visible.length

  const handleRecycle = async (spool: FilamentSpool) => {
    const ok = await confirm({
      title: 'Move spool to recycle bin?',
      description: 'You can restore it later from the recycle bin.',
      confirmLabel: 'Move to recycle bin',
      color: 'danger'
    })
    if (ok) recycle.mutate(spool.id)
  }

  const handleBulkRecycle = async () => {
    const targets = selectedSpools
    if (targets.length === 0) return
    const ok = await confirm({
      title: targets.length === 1 ? 'Move spool to recycle bin?' : `Move ${targets.length} spools to recycle bin?`,
      description: 'You can restore them later from the recycle bin.',
      confirmLabel: 'Move to recycle bin',
      color: 'danger'
    })
    if (!ok) return
    await Promise.allSettled(targets.map((spool) => recycle.mutateAsync(spool.id)))
    setSelectionMode(false)
  }

  const handleBulkUnload = async () => {
    if (loadedSelected.length === 0) return
    await Promise.allSettled(loadedSelected.map((spool) => unassign.mutateAsync(spool.id)))
  }

  const renderRows = (items: FilamentSpool[]) => {
    const common = {
      spools: items,
      onEdit: setEditing,
      onAdjust: setAdjusting,
      onUnassign: (spool: FilamentSpool) => unassign.mutate(spool.id),
      onRecycle: handleRecycle,
      selectable: selection.selectionMode,
      selectedIds: selection.selectedIds,
      onToggleSelect: selection.toggle
    }
    return directory.effectiveViewMode === 'list' ? <SpoolList {...common} /> : <SpoolGrid {...common} />
  }

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between" sx={{ flexWrap: 'wrap' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography level="h2" startDecorator={<FilamentSpoolIcon />}>Filament</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            Track your spools — what's in stock, how much is left, and which printers they're loaded into.
          </Typography>
          {summary.count > 0 && (
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft">{summary.count} spools</Chip>
              <Chip size="sm" variant="soft">{summary.remainingKg.toFixed(2)} kg left</Chip>
              {summary.valueCents > 0 && <Chip size="sm" variant="soft">~${(summary.valueCents / 100).toFixed(0)} on hand</Chip>}
            </Stack>
          )}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          {!directory.isMobile && !selection.selectionMode && spools.length > 0 && (
            <Button size="sm" variant="soft" onClick={() => setSelectionMode(true)}>Select...</Button>
          )}
          <Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setCreating(true)}>Add spool</Button>
        </Stack>
      </Stack>

      {selection.selectionMode && (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}
        >
          <Button
            size="sm"
            variant="soft"
            onClick={() => setAllSelected(!allVisibleSelected)}
            disabled={directory.visible.length === 0}
          >
            {allVisibleSelected ? 'Clear all' : 'Select all'}
          </Button>
          <Button size="sm" variant="plain" onClick={() => setSelectionMode(false)}>Cancel</Button>
          <Button
            size="sm"
            variant="soft"
            startDecorator={<EjectRoundedIcon />}
            disabled={loadedSelected.length === 0 || unassign.isPending}
            onClick={() => void handleBulkUnload()}
          >
            Unload selected{loadedSelected.length > 0 ? ` (${loadedSelected.length})` : ''}
          </Button>
          <Button
            size="sm"
            color="danger"
            startDecorator={<DeleteRoundedIcon />}
            disabled={selectedSpools.length === 0}
            loading={recycle.isPending}
            onClick={() => void handleBulkRecycle()}
          >
            Recycle selected{selectedSpools.length > 0 ? ` (${selectedSpools.length})` : ''}
          </Button>
        </Stack>
      )}

      {spoolsQuery.isError && (
        <Alert color="danger" variant="soft">{extractErrorMessage(spoolsQuery.error, 'Could not load spools.')}</Alert>
      )}

      <SpoolDirectoryToolbar directory={directory} />

      <SpoolResults
        directory={directory}
        hasAnySpools={spools.length > 0}
        loading={spoolsQuery.isLoading}
        renderRows={renderRows}
        emptyState={
          <EmptyState
            icon={<FilamentSpoolIcon />}
            title="No spools yet"
            description="Add a spool manually, or insert a Bambu spool into an AMS slot to add it automatically."
            action={<Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setCreating(true)}>Add spool</Button>}
          />
        }
        noMatchState={
          <EmptyState icon={<FilamentSpoolIcon />} title="No matching spools" description="Try adjusting your search or filters." compact />
        }
      />

      <SpoolFormDialog open={creating || editing != null} spool={editing} onClose={() => { setCreating(false); setEditing(null) }} />
      <SpoolAdjustDialog spool={adjusting} onClose={() => setAdjusting(null)} />
    </Stack>
  )
}
