/**
 * Filament-manager contributions for calibration target selection and display.
 * The calibration plugin owns saved values but not spool inventory, so these
 * slot components provide the rich visual picker without either plugin importing
 * the other. Only spools in the calibrated material family are selectable.
 */
import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Card, DialogTitle, ModalClose, Stack, Typography } from '@mui/joy'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import LibraryAddRoundedIcon from '@mui/icons-material/LibraryAddRounded'
import { extractErrorMessage, normalizeFilamentFamily, type FilamentSpool, type SpoolCreateInput } from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { EmptyState } from '../../components/EmptyState'
import { FilamentSpoolIcon } from '../../components/FilamentSpoolIcon'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { SpoolDirectoryToolbar } from './SpoolDirectoryToolbar'
import { SpoolGrid } from './SpoolGrid'
import { SpoolResults } from './SpoolResults'
import { SpoolColorSwatch, SpoolRemaining } from './SpoolVisuals'
import { findLoadedSpoolForSlot, spoolTitle } from './filters'
import { useSpoolMutations, useSpoolsQuery } from './api'
import { useSpoolDirectory } from './useSpoolDirectory'
import { SpoolFormDialog } from './SpoolFormDialog'
import { toast } from '../../lib/toast'

const CALIBRATION_PICKER_PREFS_KEY = 'printstream.filament.calibration-picker'

interface IdentitySuggestions {
  brand: string[]
  filamentType: string[]
  materialSubtype: Array<{ filamentType: string | null; label: string }>
  colorName: string[]
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** Compact but visual spool identity used both in the result form and saved-values table. */
function SpoolSummary({ spool }: { spool: FilamentSpool }) {
  return (
    <Card variant="outlined" size="sm" orientation="horizontal" sx={{ alignItems: 'center', gap: 1, minWidth: 0 }}>
      <SpoolColorSwatch colorHex={spool.colorHex} colors={spool.colors} size={32} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="title-sm" noWrap>{spoolTitle(spool)}</Typography>
        <SpoolRemaining
          remainingGrams={spool.remainingGrams}
          remainPercent={spool.remainPercent}
          netWeightGrams={spool.netWeightGrams}
        />
      </Box>
    </Card>
  )
}

/** Rich multi-select picker contributed into the calibration result dialog. */
export function CalibrationSpoolPicker(props: Record<string, unknown>) {
  const selectedIds = asStringArray(props.selectedSpoolIds)
  const onChange = typeof props.onSelectedSpoolIdsChange === 'function'
    ? props.onSelectedSpoolIdsChange as (ids: string[]) => void
    : null
  const filamentType = typeof props.filamentType === 'string' ? props.filamentType : null
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  const amsId = typeof props.amsId === 'number' ? props.amsId : null
  const slotId = typeof props.slotId === 'number' ? props.slotId : null
  const [open, setOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const spoolsQuery = useSpoolsQuery()
  const { assign } = useSpoolMutations()
  const allSpools = useMemo(() => spoolsQuery.data ?? [], [spoolsQuery.data])
  const family = normalizeFilamentFamily(filamentType)
  const eligibleSpools = useMemo(
    () => allSpools.filter((spool) => spool.archivedAt == null && (!family || normalizeFilamentFamily(spool.filamentType) === family)),
    [allSpools, family]
  )
  const selected = useMemo(
    () => selectedIds.map((id) => allSpools.find((spool) => spool.id === id)).filter((spool): spool is FilamentSpool => spool != null),
    [allSpools, selectedIds]
  )
  const directory = useSpoolDirectory(eligibleSpools, { storageKey: CALIBRATION_PICKER_PREFS_KEY })
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const loadedSpool = findLoadedSpoolForSlot(allSpools, { printerId, amsId, slotId })
  const initialValues = useMemo<Partial<SpoolCreateInput>>(() => ({
    filamentType: filamentType ?? 'PLA',
    brand: typeof props.brand === 'string' ? props.brand : null,
    materialSubtype: typeof props.materialSubtype === 'string' ? props.materialSubtype : null,
    colorName: typeof props.colorName === 'string' ? props.colorName : null
  }), [filamentType, props.brand, props.colorName, props.materialSubtype])

  useEffect(() => {
    if (onChange && selectedIds.length === 0 && loadedSpool) onChange([loadedSpool.id])
  }, [loadedSpool, onChange, selectedIds.length])

  if (!onChange) return null

  const toggle = (spool: FilamentSpool) => {
    const next = new Set(selectedIds)
    if (next.has(spool.id)) next.delete(spool.id)
    else next.add(spool.id)
    onChange([...next])
  }

  const renderRows = (spools: FilamentSpool[]) => (
    <SpoolGrid spools={spools} selectable selectedIds={selectedSet} onToggleSelect={toggle} />
  )

  const addCurrentSpool = async (spool: FilamentSpool) => {
    if (printerId && amsId != null) {
      try {
        await assign.mutateAsync({ id: spool.id, input: { printerId, amsId, slotId } })
        toast.success(`Loaded ${spoolTitle(spool)} here`)
      } catch (error) {
        toast.error(extractErrorMessage(error, 'Saved the spool, but could not link it to this AMS slot.'))
      }
    }
    onChange([...new Set([...selectedIds, spool.id])])
  }

  return (
    <Stack spacing={1}>
      {selected.length > 0 ? (
        <Box sx={{ display: 'grid', gap: 0.75, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))' }}>
          {selected.map((spool) => <SpoolSummary key={spool.id} spool={spool} />)}
        </Box>
      ) : (
        <Typography level="body-sm" textColor="text.tertiary">
          Choose the spools from the filament library that should use this calibration.
        </Typography>
      )}
      <Button
        size="sm"
        variant="soft"
        color="neutral"
        startDecorator={<Inventory2RoundedIcon />}
        onClick={() => setOpen(true)}
        sx={{ alignSelf: 'flex-start' }}
      >
        {selected.length > 0 ? `Choose spools (${selected.length})` : 'Choose spools'}
      </Button>
      {!loadedSpool && printerId && amsId != null ? (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          startDecorator={<LibraryAddRoundedIcon />}
          onClick={() => setAddOpen(true)}
          sx={{ alignSelf: 'flex-start' }}
        >
          Add this spool to the library
        </Button>
      ) : null}

      <Modal open={open} onClose={() => setOpen(false)}>
        <ScrollableModalDialog variant="outlined" sx={{ width: { xs: '100%', sm: 760 }, maxWidth: '100%' }}>
          <ModalClose />
          <DialogTitle>Choose calibrated spools</DialogTitle>
          <Typography level="body-sm" textColor="text.tertiary">
            Select every physical {filamentType ?? 'filament'} spool this measured value should apply to.
          </Typography>
          <ScrollableDialogBody sx={{ mt: 1, p: 0 }}>
            <Stack spacing={1.5} sx={{ minWidth: 0 }}>
              <SpoolDirectoryToolbar directory={directory} compactControls pinnable={false} />
              <SpoolResults
                directory={directory}
                hasAnySpools={eligibleSpools.length > 0}
                loading={spoolsQuery.isLoading}
                renderRows={renderRows}
                emptyState={
                  <EmptyState
                    icon={<FilamentSpoolIcon />}
                    title={`No ${filamentType ?? 'matching'} spools in the library`}
                    description="Add this spool or assign an existing one."
                    compact
                  />
                }
                noMatchState={<EmptyState icon={<FilamentSpoolIcon />} title="No matching spools" description="Try adjusting your search or filters." compact />}
              />
            </Stack>
          </ScrollableDialogBody>
          <Stack direction="row" justifyContent="flex-end" sx={{ pt: 1 }}>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </Stack>
        </ScrollableModalDialog>
      </Modal>
      <SpoolFormDialog
        open={addOpen}
        spool={null}
        initialValues={initialValues}
        onSaved={addCurrentSpool}
        onClose={() => setAddOpen(false)}
      />
    </Stack>
  )
}

/** Supplies calibration's creatable identity fields with values from the Filament library. */
export function CalibrationIdentitySuggestions(props: Record<string, unknown>) {
  const onChange = typeof props.onSuggestionsChange === 'function'
    ? props.onSuggestionsChange as (suggestions: IdentitySuggestions) => void
    : null
  const spoolsQuery = useSpoolsQuery()
  const suggestions = useMemo<IdentitySuggestions>(() => {
    const spools = spoolsQuery.data ?? []
    const values = (field: keyof IdentitySuggestions) => [...new Set(spools
      .map((spool) => spool[field]?.trim())
      .filter((value): value is string => Boolean(value)))]
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    return {
      brand: values('brand'),
      filamentType: values('filamentType'),
      materialSubtype: spools.flatMap((spool) => spool.materialSubtype?.trim()
        ? [{ filamentType: spool.filamentType, label: spool.materialSubtype.trim() }]
        : []),
      colorName: values('colorName')
    }
  }, [spoolsQuery.data])

  useEffect(() => {
    onChange?.(suggestions)
  }, [onChange, suggestions])

  return null
}

/** Visual target label contributed into the saved-calibration table. */
export function CalibrationSpoolTarget(props: Record<string, unknown>) {
  const spoolId = typeof props.spoolId === 'string' ? props.spoolId : null
  const spoolsQuery = useSpoolsQuery()
  const spool = spoolId ? spoolsQuery.data?.find((candidate) => candidate.id === spoolId) : null
  if (!spool) return <Typography level="body-sm" textColor="text.tertiary">Specific spool</Typography>
  return <SpoolSummary spool={spool} />
}
