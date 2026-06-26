import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Box, Button, Chip, FormControl, FormLabel, Input, ModalClose, Option, Select, Sheet, Stack, Typography } from '@mui/joy'
import DragIndicatorRoundedIcon from '@mui/icons-material/DragIndicatorRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { type Printer, type PrinterView, type PrinterViewInput } from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { DialogSection } from '../../components/DialogSection'
import { PrinterCardContentSettingsFields } from './PrinterCardContentSettingsFields'
import { CARDS_PER_ROW_OPTIONS, moveListItem, updateViewCardContentSetting, clonePrinterViewInput, resetPrinterViewInput, normalizePrinterViewInput } from '../../lib/printersViewHelpers'

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
  onSetAsDefault
}: {
  mode: 'settings' | 'create'
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
}) {
  const [formValues, setFormValues] = useState<PrinterViewInput>(() => clonePrinterViewInput(currentState))
  const editingView = mode === 'settings' ? activeView : null
  const isDefaultView = mode === 'settings' && editingView == null
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
        <Typography level="h4">{isCreatingView ? 'New view' : 'View settings'}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {isCreatingView
            ? 'Save the current dashboard view — its sort, grouping, filters, layout, and card content — as a named view.'
            : `Configure ${currentViewLabel}: layout and card content. Sort, grouping, and filters are set from the toolbar.`}
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

            <DialogSection title="Layout">
              <FormControl sx={{ maxWidth: 280 }}>
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
              description="Reset the layout and card content to the standard, or save this view as the workspace default."
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
                  onClick={() => setFormValues((current) => {
                    // Only the dialog-owned fields reset here; sort/grouping/filters/printers
                    // are toolbar-owned and must survive (they pass through unchanged).
                    const defaults = resetPrinterViewInput(current)
                    return { ...current, cardsPerRow: defaults.cardsPerRow, cardContentSettings: defaults.cardContentSettings }
                  })}
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
