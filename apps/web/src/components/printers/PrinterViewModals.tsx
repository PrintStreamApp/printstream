import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Box, Button, Checkbox, Chip, FormControl, FormLabel, Input, ListDivider, ModalClose, Option, Select, Sheet, Stack, Typography } from '@mui/joy'
import DragIndicatorRoundedIcon from '@mui/icons-material/DragIndicatorRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import SortRoundedIcon from '@mui/icons-material/SortRounded'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { type Printer, type PrinterView, type PrinterViewInput } from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { DialogSection } from '../../components/DialogSection'
import { PrinterCardContentSettingsFields } from './PrinterCardContentSettingsFields'
import { CARDS_PER_ROW_OPTIONS, PRINTER_VIEW_SORT_OPTIONS, moveListItem, updateViewCardContentSetting, togglePrinterSelection, buildPrinterModelFilterOptions, buildNozzleDiameterFilterOptions, buildPlateTypeFilterOptions, clonePrinterViewInput, resetPrinterViewInput, normalizePrinterViewInput, encodePrinterViewSort, decodePrinterViewSort } from '../../lib/printersViewHelpers'

/**
 * Printer view configuration modals: reorder printers (PrinterSortModal) and
 * create/edit/delete a saved printer view (PrinterViewsModal). The per-card
 * content toggles render through the shared PrinterCardContentSettingsFields.
 */

export function PrinterSortModal({
  printers,
  submitting,
  error,
  onCancel,
  onSubmit
}: {
  printers: Printer[]
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (orderedIds: string[]) => void
}) {
  const [orderedPrinters, setOrderedPrinters] = useState(printers)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const draggedPrinterIdRef = useRef<string | null>(null)

  useEffect(() => {
    setOrderedPrinters(printers)
  }, [printers])

  const applyDrop = useCallback((targetId: string) => {
    const draggedPrinterId = draggedPrinterIdRef.current
    if (!draggedPrinterId || draggedPrinterId === targetId) return
    setOrderedPrinters((current) => {
      const fromIndex = current.findIndex((printer) => printer.id === draggedPrinterId)
      const toIndex = current.findIndex((printer) => printer.id === targetId)
      if (fromIndex < 0 || toIndex < 0) return current
      return moveListItem(current, fromIndex, toIndex)
    })
  }, [])

  const endDrag = () => {
    draggedPrinterIdRef.current = null
    setDropTargetId(null)
  }

  const hasChanges = orderedPrinters.length !== printers.length
    || orderedPrinters.some((printer, index) => printer.id !== printers[index]?.id)

  return (
    <Modal open onClose={onCancel}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 560 } }}>
        <ModalClose />
        <Typography level="h4">Sort printers</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.5 }}>
          Drag printers into the order you want on the dashboard.
        </Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={1}>
            {orderedPrinters.map((printer, index) => {
              const isDropTarget = dropTargetId === printer.id
              return (
                <Sheet
                  key={printer.id}
                  variant="soft"
                  draggable
                  onDragStart={(event: DragEvent<HTMLElement>) => {
                    draggedPrinterIdRef.current = printer.id
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', printer.id)
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(event: DragEvent<HTMLElement>) => {
                    const draggedPrinterId = draggedPrinterIdRef.current
                    if (!draggedPrinterId || draggedPrinterId === printer.id) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropTargetId(printer.id)
                  }}
                  onDragLeave={() => {
                    setDropTargetId((current) => (current === printer.id ? null : current))
                  }}
                  onDrop={(event: DragEvent<HTMLElement>) => {
                    event.preventDefault()
                    applyDrop(printer.id)
                    endDrag()
                  }}
                  sx={{
                    px: 1.25,
                    py: 1,
                    borderRadius: 'md',
                    border: '1px solid',
                    borderColor: isDropTarget ? 'primary.500' : 'divider',
                    boxShadow: isDropTarget ? '0 0 0 1px var(--joy-palette-primary-500)' : 'none',
                    transition: 'border-color 120ms ease, box-shadow 120ms ease'
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip size="sm" variant="soft" color="neutral">{index + 1}</Chip>
                    <Box
                      aria-hidden
                      sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'text.tertiary',
                        cursor: 'grab'
                      }}
                    >
                      <DragIndicatorRoundedIcon fontSize="small" />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography level="title-sm" noWrap>{printer.name}</Typography>
                      <Typography level="body-xs" textColor="text.tertiary" noWrap>
                        {printer.model} · {printer.host}
                      </Typography>
                    </Box>
                  </Stack>
                </Sheet>
              )
            })}
            {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onCancel}>Cancel</Button>
          <Button
            startDecorator={<SaveRoundedIcon />}
            loading={submitting}
            disabled={!hasChanges}
            onClick={() => onSubmit(orderedPrinters.map((printer) => printer.id))}
          >
            Save order
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function PrinterViewsModal({
  mode,
  printers,
  activeView,
  currentViewLabel,
  isCurrentDefaultView,
  currentState,
  submitting,
  error,
  onClose,
  onApplyDefault,
  onCreate,
  onUpdate,
  onDelete,
  onSetAsDefault,
  onEditManualOrder
}: {
  mode: 'edit' | 'create'
  printers: Printer[]
  activeView: PrinterView | null
  currentViewLabel: string
  isCurrentDefaultView: boolean
  currentState: PrinterViewInput
  submitting: boolean
  error: string | null
  onClose: () => void
  onApplyDefault: (input: PrinterViewInput) => void
  onCreate: (input: PrinterViewInput) => void
  onUpdate: (id: string, input: PrinterViewInput) => void
  onDelete: (id: string) => void
  onSetAsDefault: () => void
  onEditManualOrder: () => void
}) {
  const [formValues, setFormValues] = useState<PrinterViewInput>(() => clonePrinterViewInput(currentState))
  const modelFilterOptions = useMemo(
    () => buildPrinterModelFilterOptions(printers, formValues.modelFilter),
    [printers, formValues.modelFilter]
  )
  const nozzleDiameterFilterOptions = useMemo(
    () => buildNozzleDiameterFilterOptions(formValues.nozzleDiameterFilter),
    [formValues.nozzleDiameterFilter]
  )
  const plateTypeFilterOptions = useMemo(
    () => buildPlateTypeFilterOptions(printers, formValues.plateTypeFilter),
    [printers, formValues.plateTypeFilter]
  )
  const editingView = mode === 'edit' ? activeView : null
  const isDefaultView = mode === 'edit' && editingView == null
  const isCreatingView = mode === 'create'
  const canSubmitView = !isCreatingView || formValues.name.trim().length > 0

  const submitView = () => {
    if (editingView) onUpdate(editingView.id, normalizePrinterViewInput(formValues))
    else if (isCreatingView) onCreate(normalizePrinterViewInput(formValues))
  }

  const handleFormSubmit = (event: React.FormEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (!canSubmitView || submitting) return
    submitView()
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog
        component="form"
        onSubmit={handleFormSubmit}
        sx={{
          width: { xs: '96vw', sm: 720 },
          maxWidth: '100%'
        }}
      >
        <ModalClose />
        <Typography level="h4">{isCreatingView ? 'New view' : 'Edit view'}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {isCreatingView
            ? 'Create a saved printer view from the current dashboard state, including layout, filter, sorting, and card content options.'
            : `Configure ${currentViewLabel} from one place, including layout, filter, sorting, and card content options.`}
        </Typography>

        <ScrollableDialogBody sx={{ mt: 1.5 }}>
          <Stack spacing={2}>
            <DialogSection
              title={isCreatingView ? 'View' : 'View details'}
              description={isDefaultView ? 'Overview only persists on this device.' : undefined}
            >
              {isCreatingView || !isDefaultView ? (
                <FormControl>
                  <FormLabel>Name</FormLabel>
                  <Input
                    value={formValues.name}
                    onChange={(event) => setFormValues((current) => ({ ...current, name: event.target.value }))}
                  />
                </FormControl>
              ) : (
                <Typography level="body-sm">
                  Changes to Overview only persist on this device.
                </Typography>
              )}
            </DialogSection>

            <DialogSection title="Layout and sorting">
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Cards per row</FormLabel>
                  <Select
                    value={formValues.cardsPerRow}
                    onChange={(_event, value) => value && setFormValues((current) => ({ ...current, cardsPerRow: value }))}
                  >
                    {CARDS_PER_ROW_OPTIONS.map((value) => (
                      <Option key={`view-cards-${value}`} value={value}>{value} per row</Option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Sort</FormLabel>
                  <Stack spacing={0.75}>
                    <Select
                      value={encodePrinterViewSort(formValues.sort)}
                      onChange={(_event, value) => {
                        if (!value) return
                        setFormValues((current) => ({ ...current, sort: decodePrinterViewSort(value) }))
                      }}
                    >
                      {PRINTER_VIEW_SORT_OPTIONS.map((option) => (
                        <Option key={encodePrinterViewSort(option.value)} value={encodePrinterViewSort(option.value)}>
                          {option.label}
                        </Option>
                      ))}
                    </Select>
                    {formValues.sort.key === 'manual' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="plain"
                        color="neutral"
                        startDecorator={<SortRoundedIcon />}
                        disabled={printers.length < 2}
                        onClick={onEditManualOrder}
                        sx={{ alignSelf: 'flex-start' }}
                      >
                        Edit manual order
                      </Button>
                    )}
                  </Stack>
                </FormControl>
              </Stack>
            </DialogSection>

            <DialogSection
              title="Filters"
              description="Limit the view to printers matching every selected filter. Leave a filter empty to include all printers."
            >
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1.25}
                useFlexGap
                sx={{ flexWrap: 'wrap' }}
              >
                <FormControl sx={{ flex: '1 1 45%', minWidth: 180 }}>
                  <FormLabel>State</FormLabel>
                  <Select
                    value={formValues.stateFilter}
                    onChange={(_event, value) => value && setFormValues((current) => ({ ...current, stateFilter: value }))}
                  >
                    <Option value="all">All states</Option>
                    <Option value="idle">Idle</Option>
                    <Option value="printing">Printing</Option>
                    <Option value="paused">Paused</Option>
                    <Option value="error">Error</Option>
                    <Option value="offline">Offline</Option>
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: '1 1 45%', minWidth: 180 }}>
                  <FormLabel>Model</FormLabel>
                  <Select
                    multiple
                    placeholder="All models"
                    value={formValues.modelFilter}
                    onChange={(_event, value) => setFormValues((current) => ({ ...current, modelFilter: value }))}
                    renderValue={(selected) => (selected.length === 0 ? 'All models' : selected.map((option) => option.label).join(', '))}
                    slotProps={{ listbox: { sx: { maxHeight: 280, overflow: 'auto' } } }}
                  >
                    {modelFilterOptions.map((model) => (
                      <Option key={`view-model-${model}`} value={model}>{model}</Option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: '1 1 45%', minWidth: 180 }}>
                  <FormLabel>Nozzle diameter</FormLabel>
                  <Select
                    multiple
                    placeholder="All sizes"
                    value={formValues.nozzleDiameterFilter}
                    onChange={(_event, value) => setFormValues((current) => ({ ...current, nozzleDiameterFilter: value }))}
                    renderValue={(selected) => (selected.length === 0 ? 'All sizes' : selected.map((option) => `${option.value} mm`).join(', '))}
                    slotProps={{ listbox: { sx: { maxHeight: 280, overflow: 'auto' } } }}
                  >
                    {nozzleDiameterFilterOptions.map((diameter) => (
                      <Option key={`view-nozzle-${diameter}`} value={diameter}>{diameter} mm</Option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: '1 1 45%', minWidth: 180 }}>
                  <FormLabel>Plate type</FormLabel>
                  <Select
                    multiple
                    placeholder="All plate types"
                    value={formValues.plateTypeFilter}
                    onChange={(_event, value) => setFormValues((current) => ({ ...current, plateTypeFilter: value }))}
                    renderValue={(selected) => (selected.length === 0 ? 'All plate types' : selected.map((option) => option.label).join(', '))}
                    slotProps={{ listbox: { sx: { maxHeight: 280, overflow: 'auto' } } }}
                  >
                    {plateTypeFilterOptions.map((plateType) => (
                      <Option key={`view-plate-${plateType}`} value={plateType}>{plateType}</Option>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            </DialogSection>

            <DialogSection
              title="Printers"
              description="Leave the selection empty to include every configured printer."
            >
              <Stack spacing={1}>
                {formValues.printerIds.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="plain"
                    color="neutral"
                    onClick={() => setFormValues((current) => ({ ...current, printerIds: [] }))}
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    Use all printers
                  </Button>
                )}
                <Sheet variant="soft" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
                  <Stack divider={<ListDivider inset="gutter" />}>
                    {printers.map((printer) => {
                      const checked = formValues.printerIds.includes(printer.id)
                      return (
                        <Stack
                          key={printer.id}
                          direction="row"
                          spacing={1.25}
                          alignItems="center"
                          onClick={() => {
                            setFormValues((current) => ({
                              ...current,
                              printerIds: togglePrinterSelection(current.printerIds, printer.id)
                            }))
                          }}
                          sx={{ px: 1.5, py: 1, cursor: 'pointer' }}
                        >
                          <Checkbox
                            checked={checked}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => {
                              setFormValues((current) => ({
                                ...current,
                                printerIds: togglePrinterSelection(current.printerIds, printer.id)
                              }))
                            }}
                          />
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography level="title-sm" noWrap>{printer.name}</Typography>
                            <Typography level="body-xs" textColor="text.tertiary" noWrap>
                              {printer.model} · {printer.host}
                            </Typography>
                          </Box>
                        </Stack>
                      )
                    })}
                  </Stack>
                </Sheet>
              </Stack>
            </DialogSection>

            <DialogSection
              title="Card content"
              description="Choose which status blocks appear on each printer card."
            >
              <PrinterCardContentSettingsFields
                value={formValues.cardContentSettings}
                onChange={(key, checked) => updateViewCardContentSetting(setFormValues, key, checked)}
              />
            </DialogSection>

            {error && <Typography color="danger" level="body-sm">{error}</Typography>}

            <DialogSection
              title="Defaults"
              description="Reset this view back to the standard layout or save it as the default for this workspace."
            >
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}
              >
                <Button
                  type="button"
                  variant="plain"
                  color="neutral"
                  onClick={() => setFormValues((current) => resetPrinterViewInput(current))}
                >
                  Reset to defaults
                </Button>
                {!isCreatingView && !isCurrentDefaultView && (
                  <Button
                    type="button"
                    variant="soft"
                    color="neutral"
                    onClick={onSetAsDefault}
                  >
                    Set as default
                  </Button>
                )}
              </Stack>
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>

        <Stack spacing={1} sx={{ mt: 2 }}>
          <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
            {editingView ? (
              <Button
                type="button"
                variant="soft"
                color="danger"
                loading={submitting}
                onClick={() => onDelete(editingView.id)}
              >
                Delete
              </Button>
            ) : (
              <Box />
            )}
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: 'wrap', justifyContent: 'flex-end', ml: 'auto' }}
            >
              <Button type="button" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
              {isDefaultView && (
                <Button
                  type="button"
                  variant="soft"
                  color="neutral"
                  onClick={() => onApplyDefault(normalizePrinterViewInput(formValues))}
                >
                  Apply
                </Button>
              )}
              {(editingView || isCreatingView) && (
                <Button
                  type="submit"
                  loading={submitting}
                  disabled={!canSubmitView}
                >
                  {editingView ? 'Save view' : 'Create view'}
                </Button>
              )}
            </Stack>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
