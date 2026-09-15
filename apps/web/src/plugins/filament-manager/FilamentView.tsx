/**
 * Filament tab: a directory-style spool inventory with catalog-backed barcode
 * scanning, search, filters, grouping, sort, and list/icon views. Remaining filament shows both
 * graphically (bar) and numerically. The directory controls + grouped/paginated
 * rendering are the shared spool primitives ({@link useSpoolDirectory},
 * {@link SpoolDirectoryToolbar}, {@link SpoolResults}), the same ones the
 * AMS-slot spool picker uses, so the two stay in sync.
 *
 * Desktop adds a multi-select mode ({@link useSpoolSelection}) with a bulk action
 * bar for unloading and recycling several spools at once.
 */
import { useCallback, useMemo, useState } from 'react'
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import QrCodeScannerRoundedIcon from '@mui/icons-material/QrCodeScannerRounded'
import EjectRoundedIcon from '@mui/icons-material/EjectRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import type { FilamentBarcodeProduct, FilamentSpool, SpoolCreateInput } from '@printstream/shared'
import { extractErrorMessage } from '@printstream/shared'
import { EmptyState } from '../../components/EmptyState'
import { BulkSelectionActions } from '../../components/BulkSelectionActions'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { FilamentSpoolIcon } from '../../components/FilamentSpoolIcon'
import { useSpoolsQuery, useSpoolMutations } from './api'
import { SpoolList } from './SpoolList'
import { SpoolGrid } from './SpoolGrid'
import { SpoolFormDialog } from './SpoolFormDialog'
import { SpoolBarcodeDialog } from './SpoolBarcodeDialog'
import { SpoolAdjustDialog } from './SpoolAdjustDialog'
import { SpoolDirectoryToolbar } from './SpoolDirectoryToolbar'
import { SpoolResults } from './SpoolResults'
import { useSpoolDirectory } from './useSpoolDirectory'
import { useSpoolSelection } from './useSpoolSelection'

export function FilamentView() {
  const spoolsQuery = useSpoolsQuery()
  const { recycle, unassign } = useSpoolMutations()
  const { confirm } = usePromptDialog()

  const [editing, setEditing] = useState<FilamentSpool | null>(null)
  const [creating, setCreating] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scannedValues, setScannedValues] = useState<Partial<SpoolCreateInput> | null>(null)
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
  const someVisibleSelected = selectedSpools.length > 0 && !allVisibleSelected

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

  const handleBarcodeResolved = useCallback((product: FilamentBarcodeProduct) => {
    setScannedValues({
      brand: product.brand,
      filamentType: product.filamentType,
      materialSubtype: product.materialSubtype,
      colorName: product.colorName,
      colorHex: product.colorHex,
      diameterMm: product.diameterMm ?? undefined,
      netWeightGrams: product.netWeightGrams ?? undefined,
      remainingGrams: product.netWeightGrams ?? undefined,
      spoolCoreGrams: product.spoolCoreGrams,
      nozzleTempMin: product.nozzleTempMin,
      nozzleTempMax: product.nozzleTempMax,
      productCode: product.productCode
    })
  }, [])

  const closeScanner = useCallback(() => setScanning(false), [])

  const selectionActions = selection.selectionMode ? (
    <BulkSelectionActions onCancel={() => setSelectionMode(false)}>
      <Button
        size="sm"
        variant="soft"
        startDecorator={<EjectRoundedIcon />}
        disabled={loadedSelected.length === 0 || unassign.isPending}
        onClick={() => void handleBulkUnload()}
      >
        Unload{loadedSelected.length > 0 ? ` (${loadedSelected.length})` : ''}
      </Button>
      <Button
        size="sm"
        color="danger"
        startDecorator={<DeleteRoundedIcon />}
        disabled={selectedSpools.length === 0}
        loading={recycle.isPending}
        onClick={() => void handleBulkRecycle()}
      >
        Recycle{selectedSpools.length > 0 ? ` (${selectedSpools.length})` : ''}
      </Button>
    </BulkSelectionActions>
  ) : null

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between" sx={{ flexWrap: 'wrap' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography level="h3" startDecorator={<FilamentSpoolIcon />}>Filament</Typography>
          {summary.count > 0 && (
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft">{summary.count} spools</Chip>
              <Chip size="sm" variant="soft">{summary.remainingKg.toFixed(2)} kg left</Chip>
              {summary.valueCents > 0 && <Chip size="sm" variant="soft">~${(summary.valueCents / 100).toFixed(0)} on hand</Chip>}
            </Stack>
          )}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button size="sm" variant="soft" startDecorator={<QrCodeScannerRoundedIcon />} onClick={() => setScanning(true)}>
            Scan barcode
          </Button>
          <Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setCreating(true)}>Add spool</Button>
        </Stack>
      </Stack>

      {spoolsQuery.isError && (
        <Alert color="danger" variant="soft">{extractErrorMessage(spoolsQuery.error, 'Could not load spools.')}</Alert>
      )}

      <SpoolDirectoryToolbar
        directory={directory}
        selection={spools.length > 0 ? {
          active: selection.selectionMode,
          checked: allVisibleSelected,
          indeterminate: someVisibleSelected,
          disabled: directory.visible.length === 0,
          onActivate: () => setSelectionMode(true),
          onChange: setAllSelected,
          ariaLabel: !selection.selectionMode
            ? 'Select spools'
            : allVisibleSelected ? 'Clear all visible spools' : 'Select all visible spools'
        } : undefined}
      />

      <SpoolResults
        directory={directory}
        hasAnySpools={spools.length > 0}
        loading={spoolsQuery.isLoading}
        beforeItems={selectionActions}
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

      <SpoolBarcodeDialog open={scanning} onClose={closeScanner} onResolved={handleBarcodeResolved} />
      <SpoolFormDialog
        open={creating || editing != null || scannedValues != null}
        spool={editing}
        initialValues={scannedValues}
        onClose={() => { setCreating(false); setEditing(null); setScannedValues(null) }}
      />
      <SpoolAdjustDialog spool={adjusting} onClose={() => setAdjusting(null)} />
    </Stack>
  )
}
