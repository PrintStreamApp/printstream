/**
 * Full material browser for the queue picker: search / type-filter / sort / paginate the workspace
 * Filament library and pick a material for a required filament. Mirrors the library file picker's
 * `DirectoryPrimaryToolbar` + `PaginatedSection` composition (and the filament-manager's spool
 * directory) without importing those plugins. Default sort is "best match" to the sliced filament.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, DialogActions, DialogTitle, FormControl, FormLabel, Select, Sheet, Stack } from '@mui/joy'
import PaletteRounded from '@mui/icons-material/PaletteRounded'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { DirectoryPrimaryToolbar } from '../../components/DirectoryToolbar'
import { MultiSelectOption } from '../../components/MultiSelectOption'
import { PaginatedSection } from '../../components/PaginationFooter'
import { EmptyState } from '../../components/EmptyState'
import { FilamentOptionLabel } from '../../components/library/FilamentOptionLabel'
import { colorDistance } from '../../lib/filamentColor'
import { rankMaterialsForFilament, type LibraryMaterial } from './useFilamentLibrary'

const SORT_OPTIONS = [
  { value: 'match', label: 'Best match' },
  { value: 'name', label: 'Name' },
  { value: 'remaining', label: 'Remaining' }
] as const
type MaterialSort = (typeof SORT_OPTIONS)[number]['value']
const PAGE_SIZE_OPTIONS = [10, 25, 50].map((value) => ({ value, label: `${value} per page` }))

export function MaterialPickerDialog({
  open,
  onClose,
  onPick,
  materials,
  filamentType,
  color,
  requiredGrams
}: {
  open: boolean
  onClose: () => void
  onPick: (material: LibraryMaterial) => void
  materials: LibraryMaterial[]
  filamentType: string | null
  color: string | null
  requiredGrams?: number | null
}) {
  const [search, setSearch] = useState('')
  // Default to filtering to the sliced file's (compatible) type so the picker leads with usable
  // materials — but only when the library actually has that type, otherwise fall back to all types
  // so the dialog isn't empty on open. Clearable like any filter.
  const [types, setTypes] = useState<string[]>(() => {
    const required = (filamentType ?? '').trim().toLowerCase()
    if (!required) return []
    const match = materials.find((material) => material.filamentType.trim().toLowerCase() === required)
    return match ? [match.filamentType] : []
  })
  const [excludeLoaded, setExcludeLoaded] = useState(false)
  const [sort, setSort] = useState<MaterialSort>('match')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(1)

  const typeFacets = useMemo(() => Array.from(new Set(materials.map((m) => m.filamentType))).sort(), [materials])
  // Some materials are spools already loaded into a printer; offer to hide those from the picker.
  const hasLoaded = useMemo(() => materials.some((material) => material.loadedSpoolCount > 0), [materials])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return materials.filter((material) => {
      // When excluding loaded, drop materials whose spools are *all* loaded into machines.
      if (excludeLoaded && material.loadedSpoolCount >= material.spoolCount) return false
      if (types.length > 0 && !types.includes(material.filamentType)) return false
      if (!needle) return true
      return [material.filamentType, material.brand, material.colorName, material.color].some((field) => field?.toLowerCase().includes(needle))
    })
  }, [materials, search, types, excludeLoaded])

  const sorted = useMemo(() => {
    const factor = direction === 'asc' ? 1 : -1
    if (sort === 'match') {
      const ranked = rankMaterialsForFilament(filtered, filamentType, color)
      return direction === 'asc' ? ranked : [...ranked].reverse()
    }
    if (sort === 'remaining') {
      const remaining = (material: LibraryMaterial) => (excludeLoaded ? material.availableGrams : material.remainingGrams) ?? -1
      return [...filtered].sort((a, b) => factor * (remaining(a) - remaining(b)))
    }
    return [...filtered].sort((a, b) => factor * (`${a.filamentType} ${a.colorName ?? ''}`).localeCompare(`${b.filamentType} ${b.colorName ?? ''}`))
  }, [filtered, sort, direction, filamentType, color, excludeLoaded])

  const total = sorted.length
  const start = (page - 1) * pageSize
  const pageItems = sorted.slice(start, start + pageSize)

  useEffect(() => {
    setPage(1)
  }, [search, types, excludeLoaded, sort, direction, pageSize])

  return (
    <Modal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 640, width: '100%' }}>
        <DialogTitle>
          Choose a material{requiredGrams != null ? ` · needs ~${Math.round(requiredGrams)}g` : ''}
        </DialogTitle>
        <Stack spacing={1.5} sx={{ pt: 1, minHeight: 0, flex: 1 }}>
          <DirectoryPrimaryToolbar
            pinStorageKey="print-queue.material-picker"
            compactControls
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search materials…"
            searchAriaLabel="Search the filament library"
            filters={typeFacets.length > 0 ? {
              activeCount: types.length + (excludeLoaded ? 1 : 0),
              onClear: () => { setTypes([]); setExcludeLoaded(false) },
              clearDisabled: types.length === 0 && !excludeLoaded,
              children: (
                <Stack spacing={1.25}>
                  <FormControl>
                    <FormLabel>Type</FormLabel>
                    <Select
                      multiple
                      value={types}
                      onChange={(_event, value) => setTypes(value)}
                      placeholder="All types"
                      renderValue={() => (types.length === 0 ? null : types.join(', '))}
                      slotProps={{ listbox: { disablePortal: true } }}
                    >
                      {typeFacets.map((type) => (
                        <MultiSelectOption key={type} value={type} selected={types.includes(type)}>{type}</MultiSelectOption>
                      ))}
                    </Select>
                  </FormControl>
                  {hasLoaded ? (
                    <Checkbox
                      size="sm"
                      label="Exclude spools loaded in machines"
                      checked={excludeLoaded}
                      onChange={(event) => setExcludeLoaded(event.target.checked)}
                    />
                  ) : null}
                </Stack>
              )
            } : undefined}
            pageSizeValue={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={setPageSize}
            pageSizeAriaLabel="Materials per page"
            pageSizeRenderValue={(value) => `${value} per page`}
            sortValue={sort}
            sortOptions={SORT_OPTIONS}
            onSortValueChange={(value) => setSort(value as MaterialSort)}
            sortDirection={direction}
            onSortDirectionChange={setDirection}
            sortAriaLabel="Sort materials"
          />
          <ScrollableDialogBody>
            {total === 0 ? (
              <EmptyState
                compact
                icon={<PaletteRounded />}
                title={materials.length === 0 ? 'Your Filament library is empty' : 'No matching materials'}
                description={
                  materials.length === 0
                    ? 'Add spools in the Filament tab, or use a custom material.'
                    : excludeLoaded
                      ? 'Every matching material is loaded in a machine — clear "Exclude spools loaded in machines" to show them.'
                      : 'Try a different search or clear the type filter.'
                }
              />
            ) : (
              <PaginatedSection
                showingLabel={`Showing ${start + 1}–${Math.min(start + pageSize, total)} of ${total}`}
                previousDisabled={page <= 1}
                nextDisabled={start + pageSize >= total}
                onPrevious={() => setPage((current) => Math.max(1, current - 1))}
                onNext={() => setPage((current) => current + 1)}
              >
                <Stack spacing={0.75}>
                  {pageItems.map((material) => {
                    const requiredType = (filamentType ?? '').trim()
                    const exact = colorDistance(material.color, color) === 0 && material.filamentType.toLowerCase() === requiredType.toLowerCase()
                    const mismatch = requiredType !== '' && material.filamentType.trim().toLowerCase() !== requiredType.toLowerCase()
                    // Show where it's loaded (unless we're hiding loaded spools, where it'd be noise).
                    const loadedHint = !excludeLoaded && material.loadedSpoolCount > 0
                      ? (material.loadedPrinterNames.length > 0 ? `In ${material.loadedPrinterNames.join(', ')}` : `${material.loadedSpoolCount} loaded`)
                      : null
                    return (
                      <Sheet
                        key={material.key}
                        variant="outlined"
                        onClick={() => { onPick(material); onClose() }}
                        sx={{
                          p: 1,
                          borderRadius: 'sm',
                          cursor: 'pointer',
                          transition: 'border-color 120ms',
                          '&:hover': { borderColor: 'primary.500' }
                        }}
                      >
                        <FilamentOptionLabel
                          color={material.color}
                          filamentType={material.filamentType}
                          filamentName={material.brand}
                          secondary={[exact ? 'Exact match' : null, material.spoolCount > 1 ? `${material.spoolCount} spools` : null, loadedHint].filter(Boolean).join(' · ') || undefined}
                          remainingGrams={excludeLoaded ? material.availableGrams : material.remainingGrams}
                          remainPercent={excludeLoaded ? material.availablePercent : material.remainPercent}
                          requiredGrams={requiredGrams}
                          aggregated={(excludeLoaded ? material.spoolCount - material.loadedSpoolCount : material.spoolCount) > 1}
                          warningLabel={mismatch ? `Sliced for ${filamentType} — a different material type may not print correctly.` : null}
                        />
                      </Sheet>
                    )
                  })}
                </Stack>
              </PaginatedSection>
            )}
          </ScrollableDialogBody>
        </Stack>
        <DialogActions>
          {/* Selection commits by clicking a row, so the footer only needs a dismiss action. */}
          <Button variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}
