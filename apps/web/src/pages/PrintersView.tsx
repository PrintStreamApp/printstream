import { useDirectorySelection } from '../hooks/useDirectorySelection'
import { usePrinterDetailHistory } from '../hooks/usePrinterDetailHistory'
import { usePrinterJobMutations } from '../hooks/usePrinterJobMutations'
import { usePrinterOverviewResults } from '../hooks/usePrinterOverviewResults'
import { usePrinterOverviewPreferences } from '../hooks/usePrinterOverviewPreferences'
import { usePrinterPrintFlow } from '../hooks/usePrinterPrintFlow'
import { usePrinterViewMutations } from '../hooks/usePrinterViewMutations'
import { usePrinterViewDraft } from '../hooks/usePrinterViewDraft'
import { usePrinterViewRoute } from '../hooks/usePrinterViewRoute'
import { usePrinterDashboardData } from '../hooks/usePrinterDashboardData'
import { type PrinterViewDraft } from '../lib/printerViewDraft'
import { useTagFilter } from '../hooks/useTagFilter'
import { useTagAssignment } from '../hooks/useTagAssignment'
import { BulkSelectionActions } from '../components/BulkSelectionActions'
import LabelIcon from '@mui/icons-material/LabelOutlined'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Alert, Box, Button, Sheet, Stack, Typography } from '@mui/joy'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import SortRoundedIcon from '@mui/icons-material/SortRounded'
import { PaginatedSection } from '../components/PaginationFooter'
import { Printer3dRoundedIcon } from '../components/Printer3dRoundedIcon'
import { useNavigate, useParams } from 'react-router-dom'
import { type PrintJob, type Printer } from '@printstream/shared'
import { printerViewPath } from '../lib/printerViewRoutes'
import { printerViewsQueryKey as buildPrinterViewsQueryKey } from '../lib/printerViewsQuery'
import { toast } from '../lib/toast'
import { EmptyState } from '../components/EmptyState'
import { ConfirmActionDialog } from '../components/ConfirmActionDialog'
import { NestedViewHeader } from '../components/NestedViewHeader'
import { NoConnectedBridgesEmptyState } from '../components/NoConnectedBridgesEmptyState'
import { recentStatsDateRange, type StatsDateRangeSelection } from '../lib/statsDateRange'
import { shouldShowNoConnectedPrintersEmptyState } from '../lib/printersEmptyState'
import { usePlateClearingSync } from '../lib/plateClearing'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { buildWorkspacePath, buildWorkspaceSelectionPath } from '../lib/workspaceRoute'
import { jobToLibraryFile, printerStateFilterLabel, shouldShowPrinterOverviewDirectoryControls } from '../lib/printersViewHelpers'
import { NEW_VIEW_OPTION_VALUE, PUBLIC_DEMO_PRINTER_MUTATION_NOTICE, DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS } from '../lib/printerViewConstants'
import { PluginSlot } from '../plugin/PluginSlot'
import { PrinterOverviewHeader } from '../components/printers/PrinterOverviewHeader'
import { PrinterOverviewCardGrid } from '../components/printers/PrinterOverviewCardGrid'
import { PrinterManagementDialogs } from '../components/printers/PrinterManagementDialogs'
import { PrinterPrintFlowDialogs } from '../components/printers/PrinterPrintFlowDialogs'
import { PrinterDetailContent } from '../components/printers/PrinterDetailContent'
import { PrinterSavedViewDialogs } from '../components/printers/PrinterSavedViewDialogs'
import { PrinterCardContentSettingsModal } from '../components/printers/PrinterCardContentSettingsModal'
import { PrinterOverviewToolbar } from '../components/printers/PrinterOverviewToolbar'
import { ListSkeleton } from '../components/ListSkeleton'

/**
 * Printers dashboard. Lists configured printers with their live status
 * (sourced from the WS-fed `printer-status` cache) and supports adding
 * a new printer via a small modal.
 */
export function PrintersView() {
  const [statsDateRange, setStatsDateRange] = useState<StatsDateRangeSelection>(() => recentStatsDateRange(30))
  const { demoMode } = useRuntimePolicy()
  const navigate = useNavigate()
  const { workspaceSlug, printerId: routePrinterId, viewId: routeViewId } = useParams<{ workspaceSlug: string; printerId?: string; viewId?: string }>()
  const workspacePath = useCallback((path: string) => (
    workspaceSlug ? buildWorkspacePath(workspaceSlug, path) : buildWorkspaceSelectionPath()
  ), [workspaceSlug])
  const singlePrinterView = Boolean(routePrinterId)
  const {
    authBootstrapQuery,
    workspacePreferenceScopeKey,
    workspaceScopeKey,
    canOpenBridgesSettings,
    canDeleteJobs,
    canUploadLibrary,
    canViewPrinters,
    canManagePrinters,
    canControlPrinters,
    canViewPrinterStorage,
    canDownloadPrinterStorage,
    canDispatchPrints,
    canViewCamera,
    showNoConnectedBridgesPlaceholder,
    printersQuery,
    printerViewsQuery,
    bridgesQuery,
    discoveredQuery,
    slicingCapabilitiesQuery,
    jobsQuery,
    printerRows,
    printers,
    printerViews,
    printerStatuses,
    status,
    dispatchJobsByPrinter,
    latestFinishedJobsByPrinter,
    latestActiveJobsByPrinter
  } = usePrinterDashboardData(singlePrinterView)
  const printerViewsQueryKey = useMemo(
    () => buildPrinterViewsQueryKey(workspacePreferenceScopeKey),
    [workspacePreferenceScopeKey]
  )
  usePlateClearingSync()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Printer | null>(null)
  const printFlow = usePrinterPrintFlow(demoMode)
  const {
    setPrintTarget,
    setResliceJob,
    setPageLibraryPickerOpen,
    setPageLocalPrinterPickerOpen,
    handleCardPrint,
    handleCardPrintLocal
  } = printFlow
  const [deleteHistoryJobTarget, setDeleteHistoryJobTarget] = useState<PrintJob | null>(null)
  // One stable edit callback serves every memoized PrinterCard.
  const handleCardEdit = useCallback((printer: Printer) => setEditing(printer), [])
  const handleCardOpenDetails = useCallback(
    (printer: Printer) => navigate(workspacePath(`/printers/${printer.id}`)),
    [navigate, workspacePath]
  )
  const [sortDialogOpen, setSortDialogOpen] = useState(false)
  const [printerViewsDialogOpen, setPrinterViewsDialogOpen] = useState(false)
  const [printerViewsDialogMode, setPrinterViewsDialogMode] = useState<'settings' | 'create'>('settings')
  const [singleViewSettingsOpen, setSingleViewSettingsOpen] = useState(false)
  const {
    cardsPerRow,
    setCardsPerRow,
    stateFilter,
    setStateFilter,
    modelFilter,
    setModelFilter,
    nozzleDiameterFilter,
    setNozzleDiameterFilter,
    plateTypeFilter,
    setPlateTypeFilter,
    printerCardContentSettings,
    setPrinterCardContentSettings,
    singlePrinterCardContentSettings,
    setSinglePrinterCardContentSettings,
    defaultViewPrinterIds,
    setDefaultViewPrinterIds,
    defaultViewSort,
    setDefaultViewSort,
    defaultViewOverride,
    setDefaultViewOverride,
    sharedDefaultViewId,
    overviewGroup,
    setOverviewGroup,
    overviewPageSize,
    setOverviewPageSize
  } = usePrinterOverviewPreferences(workspacePreferenceScopeKey)

  // Overview directory-toolbar state. Search + page are ephemeral; page size is a
  // local display preference. Sort, grouping, the attribute filters, and the printer
  // selection are "view content": on a saved view they stage in `viewDraft` until the
  // user saves; on the Overview they write the local defaults (see applyToolbarChange).
  const [overviewSearch, setOverviewSearch] = useState('')
  const deferredOverviewSearch = useDeferredValue(overviewSearch)
  const [overviewPage, setOverviewPage] = useState(0)
  const showOverviewDirectoryControls = shouldShowPrinterOverviewDirectoryControls(printers.length)

  const {
    effectiveDefaultViewId,
    activeViewId: activePrinterViewId,
    activeView: activePrinterView,
    navigateToSelectedView
  } = usePrinterViewRoute({
    views: printerViews,
    viewsLoaded: Boolean(printerViewsQuery.data),
    routeViewId,
    defaultViewOverride,
    setDefaultViewOverride,
    sharedDefaultViewId,
    workspacePath,
    navigate
  })
  // Layout + card content are owned by the View settings dialog (not the toolbar),
  // so they read straight from the active view / local default.
  const effectiveCardsPerRow = activePrinterView?.cardsPerRow ?? cardsPerRow
  const effectiveCardContentSettings = activePrinterView?.cardContentSettings ?? printerCardContentSettings
  // Toolbar-owned "view content": the draft overlays the saved view; Overview reads its
  // local defaults. These drive the toolbar, filtering, sorting, and grouping below.
  const handleOverviewToolbarChange = useCallback((partial: PrinterViewDraft) => {
    if (partial.sort !== undefined) setDefaultViewSort(partial.sort)
    if (partial.group !== undefined) setOverviewGroup(partial.group)
    if (partial.stateFilter !== undefined) setStateFilter(partial.stateFilter)
    if (partial.modelFilter !== undefined) setModelFilter(partial.modelFilter)
    if (partial.nozzleDiameterFilter !== undefined) setNozzleDiameterFilter(partial.nozzleDiameterFilter)
    if (partial.plateTypeFilter !== undefined) setPlateTypeFilter(partial.plateTypeFilter)
    if (partial.printerIds !== undefined) setDefaultViewPrinterIds(partial.printerIds)
  }, [
    setDefaultViewPrinterIds,
    setDefaultViewSort,
    setModelFilter,
    setNozzleDiameterFilter,
    setOverviewGroup,
    setPlateTypeFilter,
    setStateFilter
  ])
  const resetOverviewPage = useCallback(() => setOverviewPage(0), [])
  const {
    content: effectiveViewContent,
    isDirty: isViewDirty,
    apply: applyToolbarChange,
    clear: clearViewDraft
  } = usePrinterViewDraft({
    activeView: activePrinterView,
    activeViewId: activePrinterViewId,
    overviewDefaults: {
      sort: defaultViewSort,
      group: overviewGroup,
      stateFilter,
      modelFilter,
      nozzleDiameterFilter,
      plateTypeFilter,
      printerIds: defaultViewPrinterIds
    },
    onOverviewChange: handleOverviewToolbarChange,
    onStageChange: resetOverviewPage
  })
  const {
    sort: effectiveSort,
    group: effectiveGroup,
    stateFilter: effectiveStateFilter,
    modelFilter: effectiveModelFilter,
    nozzleDiameterFilter: effectiveNozzleDiameterFilter,
    plateTypeFilter: effectivePlateTypeFilter,
    printerIds: effectivePrinterIds
  } = effectiveViewContent
  const tagFilter = useTagFilter('printer', 'printers.overview')
  const { matches: matchesTags, searchText: tagSearchText } = tagFilter
  const { openTags, tagDialog } = useTagAssignment('printer')
  useEffect(() => { setOverviewPage(0) }, [tagFilter.value])
  const bridgeNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const bridge of bridgesQuery.data?.bridges ?? []) map.set(bridge.id, bridge.name)
    return map
  }, [bridgesQuery.data?.bridges])
  const resolveBridgeName = useCallback(
    (bridgeId: string | null) => (bridgeId ? bridgeNameById.get(bridgeId) ?? 'Unknown bridge' : 'No bridge'),
    [bridgeNameById]
  )
  const { filteredPrinters, printerGroups, overviewPageCount, safeOverviewPage } = usePrinterOverviewResults({
    printers: printerRows,
    statuses: printerStatuses,
    search: deferredOverviewSearch,
    matchesTags,
    tagSearchText,
    view: effectiveViewContent,
    page: overviewPage,
    setPage: setOverviewPage,
    pageSize: overviewPageSize,
    resolveBridgeName
  })
  useEffect(() => {
    // Switching saved views starts the directory at its first page.
    setOverviewPage(0)
  }, [activePrinterViewId])
  const printerSelection = useDirectorySelection(filteredPrinters)
  const { selectionMode: tagSelectionMode, setSelectionMode: setTagSelectionMode, selectedItems: selectedTagPrinters } = printerSelection
  const allTagPrintersSelected = filteredPrinters.length > 0 && selectedTagPrinters.length === filteredPrinters.length
  const selectedPrinter = useMemo(
    () => (routePrinterId ? printers.find((printer) => printer.id === routePrinterId) ?? null : null),
    [printers, routePrinterId]
  )
  const detailHistory = usePrinterDetailHistory(jobsQuery.data?.jobs, routePrinterId)

  const { restartJob, deleteHistoryJob, replayingJobId } = usePrinterJobMutations(workspaceScopeKey)

  const {
    create: createPrinterView,
    update: updatePrinterView,
    remove: deletePrinterView,
    saveToolbarContent
  } = usePrinterViewMutations({
    queryKey: printerViewsQueryKey,
    clearDraft: clearViewDraft,
    closeDialog: () => setPrinterViewsDialogOpen(false),
    onCreated: (id) => navigate(workspacePath(printerViewPath(id))),
    onDeleted: (id) => {
      if (defaultViewOverride === id) setDefaultViewOverride(null)
      // Leave the deleted view immediately so the selector never renders with no option.
      // The route hook still repairs stale bookmarks and deletions from another session.
      if (routeViewId === id) navigate(workspacePath('/printers'), { replace: true })
    }
  })

  const handleViewSelectChange = useCallback((_event: unknown, value: string | null) => {
    if (value == null) return
    if (value === NEW_VIEW_OPTION_VALUE) {
      setPrinterViewsDialogMode('create')
      setPrinterViewsDialogOpen(true)
      return
    }
    navigateToSelectedView(value, clearViewDraft)
  }, [clearViewDraft, navigateToSelectedView])

  const saveActiveView = useCallback(() => {
    if (!activePrinterView) return
    saveToolbarContent(activePrinterView, effectiveViewContent)
  }, [activePrinterView, effectiveViewContent, saveToolbarContent])

  const isOverviewDefaultView = effectiveDefaultViewId == null

  return (
    <Stack spacing={2}>
      {demoMode && (
        <Alert color="neutral" variant="outlined" startDecorator={<InfoOutlinedIcon />}>
          <Typography level="body-sm">
            {PUBLIC_DEMO_PRINTER_MUTATION_NOTICE}
          </Typography>
        </Alert>
      )}

      {singlePrinterView ? (
        <NestedViewHeader
          crumbs={[
            { label: 'Printers', onClick: () => navigate(workspacePath('/printers')) },
            { label: selectedPrinter?.name ?? 'Printer' }
          ]}
          description={selectedPrinter
            ? `${selectedPrinter.model} details, live status, controls, storage, and print history.`
            : 'Live status, controls, storage, and print history for this printer.'}
          action={selectedPrinter ? (
            <Button
              size="sm"
              variant="soft"
              color="neutral"
              startDecorator={<TuneRoundedIcon />}
              onClick={() => setSingleViewSettingsOpen(true)}
            >
              View settings
            </Button>
          ) : null}
        />
      ) : !authBootstrapQuery.isSuccess || !canViewPrinters || showNoConnectedBridgesPlaceholder ? (
        <Stack spacing={1}>
          <Typography level="h3" startDecorator={<Printer3dRoundedIcon />}>Printers</Typography>
        </Stack>
      ) : (
        <PrinterOverviewHeader
          activeViewId={activePrinterViewId}
          views={printerViews}
          defaultViewId={effectiveDefaultViewId}
          isOverviewDefault={isOverviewDefaultView}
          canManagePrinters={canManagePrinters}
          canDispatchPrints={canDispatchPrints}
          hasBridges={(bridgesQuery.data?.bridges.length ?? 0) > 0}
          onSelectView={handleViewSelectChange}
          onOpenViewSettings={() => {
            setPrinterViewsDialogMode('settings')
            setPrinterViewsDialogOpen(true)
          }}
          onAddPrinter={() => setOpen(true)}
          onPrintFromLibrary={() => setPageLibraryPickerOpen(true)}
          onPrintFromLocalFile={() => setPageLocalPrinterPickerOpen(true)}
        />
      )}

      {authBootstrapQuery.isLoading && <ListSkeleton rows={3} />}
      {printersQuery.isLoading && canViewPrinters && <ListSkeleton rows={3} />}
      {authBootstrapQuery.isSuccess && canViewPrinters && printersQuery.error && (
        <Typography color="danger">{(printersQuery.error as Error).message}</Typography>
      )}

      {authBootstrapQuery.isSuccess && !canViewPrinters && (
        <EmptyState
          icon={<Printer3dRoundedIcon />}
          title="Printer access required"
          description="Your account can view the app shell, but not the printers dashboard."
        />
      )}

      {authBootstrapQuery.isSuccess && canViewPrinters && (singlePrinterView ? (
        <PrinterDetailContent
          printer={selectedPrinter}
          printersLoading={printersQuery.isLoading}
          hasPrintersError={Boolean(printersQuery.error)}
          statuses={status}
          dispatchJobsByPrinter={dispatchJobsByPrinter}
          activeJobsByPrinter={latestActiveJobsByPrinter}
          finishedJobsByPrinter={latestFinishedJobsByPrinter}
          contentSettings={singlePrinterCardContentSettings}
          cardProps={{
            demoMode,
            canControlPrinter: canControlPrinters,
            canManagePrinter: canManagePrinters,
            canViewPrinterStorage,
            canDownloadPrinterStorage,
            canDispatchPrints,
            canViewCamera,
            onEdit: handleCardEdit,
            onPrint: handleCardPrint,
            onPrintLocal: handleCardPrintLocal
          }}
          statsDateRange={statsDateRange}
          onStatsDateRangeChange={setStatsDateRange}
          historyProps={{
            history: detailHistory,
            jobsLoading: jobsQuery.isLoading,
            jobsError: jobsQuery.error instanceof Error ? jobsQuery.error : null,
            canDeleteJobs,
            canDispatchPrints,
            canControlPrinters,
            canSliceFiles: canUploadLibrary,
            deletingJobId: deleteHistoryJob.isPending ? deleteHistoryJob.variables ?? null : null,
            replayingJobId,
            onDelete: setDeleteHistoryJobTarget,
            onReslice: setResliceJob,
            onReprintLibrary: (reprintJob) => {
              setPrintTarget({
                file: jobToLibraryFile(reprintJob),
                printerId: reprintJob.printerId,
                defaultPlate: reprintJob.plate ?? 1,
                defaultPrintOptions: reprintJob.printOptions,
                defaultAmsMapping: reprintJob.amsMapping,
                submitPrint: async ({ printerId, body }) => {
                  await restartJob.mutateAsync({
                    jobId: reprintJob.id,
                    body: { printerId, ...body }
                  })
                }
              })
            },
            onReprintCalibration: (jobId) => restartJob.mutate({ jobId })
          }}
          onBack={() => navigate(workspacePath('/printers'))}
        />
      ) : showNoConnectedBridgesPlaceholder ? (
        <NoConnectedBridgesEmptyState
          title="Connect a bridge to add printers"
          description="Connect a bridge in Settings to bring local printers online and start monitoring them here."
          managedTitle="Waiting for your printers"
          managedDescription="Your printers will appear here once PrintStream's printer connection service is online."
          canOpenBridgesSettings={canOpenBridgesSettings}
          onOpenBridgesSettings={() => navigate(workspacePath('/settings/bridges'))}
        />
      ) : (
        <Stack spacing={1.5}>
          <PluginSlot
            name="printers.overview.actions"
            context={{ printers, statuses: status }}
          />

          {showOverviewDirectoryControls && (
            <PrinterOverviewToolbar
              printers={printers}
              tagFilter={tagFilter}
              selection={canManagePrinters ? {
                active: tagSelectionMode,
                checked: allTagPrintersSelected,
                indeterminate: selectedTagPrinters.length > 0 && !allTagPrintersSelected,
                onActivate: () => setTagSelectionMode(true),
                onChange: printerSelection.setAllSelected,
                ariaLabel: 'Select printers'
              } : undefined}
              search={overviewSearch}
              onSearchChange={(value) => { setOverviewPage(0); setOverviewSearch(value) }}
              group={effectiveGroup}
              onGroupChange={(value) => applyToolbarChange({ group: value })}
              pageSize={overviewPageSize}
              onPageSizeChange={(value) => { setOverviewPage(0); setOverviewPageSize(value) }}
              sort={effectiveSort}
              onSortFieldChange={(key) => applyToolbarChange({ sort: { key, direction: effectiveSort.direction } })}
              onSortDirectionChange={(direction) => applyToolbarChange({ sort: { key: effectiveSort.key, direction } })}
              stateFilter={effectiveStateFilter}
              onStateFilterChange={(value) => applyToolbarChange({ stateFilter: value })}
              modelFilter={effectiveModelFilter}
              onModelFilterChange={(value) => applyToolbarChange({ modelFilter: value })}
              nozzleDiameterFilter={effectiveNozzleDiameterFilter}
              onNozzleDiameterFilterChange={(value) => applyToolbarChange({ nozzleDiameterFilter: value })}
              plateTypeFilter={effectivePlateTypeFilter}
              onPlateTypeFilterChange={(value) => applyToolbarChange({ plateTypeFilter: value })}
              printerIds={effectivePrinterIds}
              onPrinterIdsChange={(value) => applyToolbarChange({ printerIds: value })}
              onClearFilters={() => {
                setOverviewSearch('')
                applyToolbarChange({ stateFilter: 'all', modelFilter: [], nozzleDiameterFilter: [], plateTypeFilter: [], printerIds: [] })
              }}
            />
          )}

          {activePrinterView && isViewDirty && (
            <Sheet
              variant="soft"
              color="warning"
              sx={{ borderRadius: 'md', px: 1.5, py: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
            >
              <Typography level="body-sm">
                Unsaved changes to <strong>{activePrinterView.name}</strong>
              </Typography>
              <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
                <Button size="sm" variant="plain" color="neutral" onClick={clearViewDraft}>Reset</Button>
                <Button size="sm" variant="solid" color="primary" startDecorator={<SaveRoundedIcon />} onClick={saveActiveView}>
                  Save changes
                </Button>
              </Stack>
            </Sheet>
          )}

          {printers.length > 1 && effectiveSort.key === 'manual' && (
            <Box>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                startDecorator={<SortRoundedIcon />}
                onClick={() => setSortDialogOpen(true)}
              >
                Edit manual order
              </Button>
            </Box>
          )}

          {shouldShowNoConnectedPrintersEmptyState({
            showNoConnectedBridgesPlaceholder,
            printersCount: printers.length,
            loading: printersQuery.isLoading,
            hasError: Boolean(printersQuery.error)
          }) && (
            <EmptyState
              icon={<Printer3dRoundedIcon />}
              title="No printers connected"
              description="Add a printer to get started."
            />
          )}

          {printers.length > 0 && filteredPrinters.length === 0 && !printersQuery.isLoading && !printersQuery.error && (
            <EmptyState
              icon={<Printer3dRoundedIcon />}
              title="No printers match this filter"
              description={
                effectiveModelFilter.length === 0
                  && effectiveNozzleDiameterFilter.length === 0
                  && effectivePlateTypeFilter.length === 0
                  && deferredOverviewSearch.trim() === ''
                  && effectiveStateFilter !== 'all'
                  ? `No printers are currently in the ${printerStateFilterLabel(effectiveStateFilter).toLowerCase()} state.`
                  : 'No printers match the current search or filters.'
              }
            />
          )}

          {tagDialog}
          {tagSelectionMode && canManagePrinters && <BulkSelectionActions onCancel={() => { setTagSelectionMode(false) }}>
            <Button size="sm" variant="soft" startDecorator={<LabelIcon />} disabled={!selectedTagPrinters.length} onClick={() => openTags(selectedTagPrinters.map((printer) => printer.id))}>Tags</Button>
          </BulkSelectionActions>}
          {filteredPrinters.length > 0 && (
            <PaginatedSection
              showingLabel={`Showing ${safeOverviewPage * overviewPageSize + 1}-${Math.min(filteredPrinters.length, (safeOverviewPage + 1) * overviewPageSize)} of ${filteredPrinters.length}`}
              previousDisabled={safeOverviewPage === 0}
              nextDisabled={safeOverviewPage >= overviewPageCount - 1}
              onPrevious={() => setOverviewPage((current) => Math.max(0, current - 1))}
              onNext={() => setOverviewPage((current) => Math.min(overviewPageCount - 1, current + 1))}
              spacing={1.5}
              showPagination={showOverviewDirectoryControls}
            >
              <PrinterOverviewCardGrid
                groups={printerGroups}
                statuses={status}
                dispatchJobsByPrinter={dispatchJobsByPrinter}
                activeJobsByPrinter={latestActiveJobsByPrinter}
                finishedJobsByPrinter={latestFinishedJobsByPrinter}
                contentSettings={effectiveCardContentSettings}
                cardsPerRow={effectiveCardsPerRow}
                selection={tagSelectionMode ? {
                  selectedIds: printerSelection.selectedIds,
                  onToggle: printerSelection.toggle
                } : undefined}
                cardProps={{
                  demoMode,
                  canControlPrinter: canControlPrinters,
                  canManagePrinter: canManagePrinters,
                  canViewPrinterStorage,
                  canDownloadPrinterStorage,
                  canDispatchPrints,
                  canViewCamera,
                  onEdit: handleCardEdit,
                  onPrint: handleCardPrint,
                  onPrintLocal: handleCardPrintLocal,
                  onOpenDetails: handleCardOpenDetails
                }}
              />
            </PaginatedSection>
          )}
        </Stack>
      ))}

      <PrinterManagementDialogs
        addOpen={open}
        editing={editing}
        sortOpen={sortDialogOpen}
        printers={printers}
        statuses={status}
        bridges={bridgesQuery.data?.bridges ?? []}
        discovered={discoveredQuery.data?.printers ?? []}
        demoMode={demoMode}
        onCloseAdd={() => setOpen(false)}
        onCloseEdit={() => setEditing(null)}
        onCloseSort={() => setSortDialogOpen(false)}
      />

      <PrinterSavedViewDialogs
        open={printerViewsDialogOpen}
        mode={printerViewsDialogMode}
        activeView={activePrinterView}
        displayedState={{
          name: '',
          printerIds: effectivePrinterIds,
          cardsPerRow: effectiveCardsPerRow,
          stateFilter: effectiveStateFilter,
          modelFilter: effectiveModelFilter,
          nozzleDiameterFilter: effectiveNozzleDiameterFilter,
          plateTypeFilter: effectivePlateTypeFilter,
          sort: effectiveSort,
          group: effectiveGroup,
          cardContentSettings: effectiveCardContentSettings
        }}
        views={printerViews}
        mutations={{ create: createPrinterView, update: updatePrinterView, remove: deletePrinterView }}
        onClose={() => setPrinterViewsDialogOpen(false)}
        onApplyDefault={(input) => {
          setCardsPerRow(input.cardsPerRow)
          setStateFilter(input.stateFilter)
          setModelFilter(input.modelFilter)
          setNozzleDiameterFilter(input.nozzleDiameterFilter)
          setPrinterCardContentSettings(input.cardContentSettings)
          setDefaultViewPrinterIds(input.printerIds)
          setDefaultViewSort(input.sort)
          toast.success('Overview updated')
          setPrinterViewsDialogOpen(false)
        }}
      />

      {singleViewSettingsOpen && (
        <PrinterCardContentSettingsModal
          initialSettings={singlePrinterCardContentSettings}
          defaultSettings={DEFAULT_SINGLE_PRINTER_CARD_CONTENT_SETTINGS}
          onClose={() => setSingleViewSettingsOpen(false)}
          onSave={(settings) => {
            setSinglePrinterCardContentSettings(settings)
            setSingleViewSettingsOpen(false)
          }}
        />
      )}

      <PrinterPrintFlowDialogs
        flow={printFlow}
        printers={printers}
        capabilities={slicingCapabilitiesQuery.data ?? null}
        capabilitiesLoading={slicingCapabilitiesQuery.isLoading && !slicingCapabilitiesQuery.data}
        capabilitiesError={slicingCapabilitiesQuery.error instanceof Error ? slicingCapabilitiesQuery.error.message : null}
        canUploadLibrary={canUploadLibrary}
        canDispatchPrints={canDispatchPrints}
        demoMode={demoMode}
      />

      <ConfirmActionDialog
        open={deleteHistoryJobTarget != null}
        title="Delete history entry?"
        description={deleteHistoryJobTarget ? `Delete "${deleteHistoryJobTarget.jobName}" from print history? This also removes any saved cover and snapshot images for this job.` : ''}
        confirmLabel="Delete history entry"
        pending={deleteHistoryJob.isPending && deleteHistoryJob.variables === deleteHistoryJobTarget?.id}
        onClose={() => setDeleteHistoryJobTarget(null)}
        onConfirm={() => {
          if (!deleteHistoryJobTarget) return
          deleteHistoryJob.mutate(deleteHistoryJobTarget.id, {
            onSettled: () => setDeleteHistoryJobTarget(null)
          })
        }}
      />


    </Stack>
  )
}
