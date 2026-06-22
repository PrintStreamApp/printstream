/**
 * Dialog components for the orders plugin.
 *
 * Owns the template editor (`TemplateDialog`) and its nested draft-item editor
 * (`TemplateDraftItemEditor`) and library-file picker
 * (`TemplateLibraryFilePickerDialog`), the order editor (`EditOrderDialog`), and
 * the order-create dialog (`OrderDialog`) with its per-copy filament color picker
 * (`OrderColorPickerModal`). These compose the pure transforms from
 * `../ordersViewHelpers`, the template-draft state helpers from
 * `../templateDraft`, and shared web primitives.
 *
 * These are extracted from `OrdersView.tsx` unchanged; behavior, props, and
 * markup are preserved.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Textarea,
  Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import type {
  LibraryBrowseResponse,
  LibraryFile,
  LibraryFolder,
  Order,
  OrderCreateInput,
  OrderTemplate,
  OrderTemplateCreateInput,
  OrderTemplateUpdateInput,
  OrderUpdateInput,
  ThreeMfProjectFilament,
  ThreeMfIndex
} from '@printstream/shared'
import { isDirectPrintableFileName } from '@printstream/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../../lib/apiClient'
import { formatLibraryFileName } from '../../../lib/libraryDisplay'
import { BackAwareModal as Modal } from '../../../components/BackAwareModal'
import { DialogSection } from '../../../components/DialogSection'
import { EmptyState } from '../../../components/EmptyState'
import { LibraryBreadcrumb } from '../../../components/LibraryBreadcrumb'
import { OverflowTooltipText } from '../../../components/OverflowTooltipText'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../../components/ScrollableDialog'
import { LibraryBrowser, LibraryFileRow, LibraryToolbar, type LibrarySort, type LibraryViewMode } from '../../../components/LibraryBrowser'
import { LibraryPlatePreview } from '../../../components/LibraryPlateSelect'
import { ColorSwatchPicker } from '../../../components/ColorSwatchPicker'
import { isUnslicedThreeMfFile } from '../../../lib/libraryFileTags'
import { buildLibraryBreadcrumb, fromBridgeFolderId, isBridgeFolderId, toBridgeFolderId } from '../../../lib/libraryNavigation'
import {
  addTemplateDraftItemPlate,
  createEmptyTemplateDraftItem,
  createEmptyTemplateDraftVariant,
  flattenTemplateDraftVariants,
  getTemplateDraftItemQuantity,
  getTemplateDraftItemTotalQuantity,
  groupTemplateVariants,
  removeTemplateDraftItemPlate,
  renameTemplateDraftItemPlate,
  setTemplateDraftItemPlateQuantity,
  type TemplateDraftItem,
  type TemplateDraftVariant
} from '../templateDraft'
import {
  buildOrderPrintFilamentOverrides,
  buildSelectedOrderVariantSelections,
  buildSelectedTemplatePrints,
  buildTemplatePrintProjectFilaments,
  buildTemplatePrintVariantCopyKey,
  countTemplateVariantCopies,
  createInitialOrderVariantQuantities,
  describeProjectFilamentColorOptions,
  formatProjectFilamentColorLabel,
  formatTemplateDraftPlateSummary,
  mergeProjectFilamentDrafts,
  normalizeProjectFilamentDraft,
  resolveProjectFilamentColorOptions,
  toColorPickerValue,
  updateProjectFilamentDraft,
  type SelectedTemplatePrintWithFilaments
} from '../ordersViewHelpers'

export function TemplateDialog({
  files,
  template,
  onClose,
  onSaved
}: {
  files: LibraryFile[]
  template: OrderTemplate | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEditing = Boolean(template)
  const [name, setName] = useState(template?.name ?? '')
  const [code, setCode] = useState(template?.code ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [notesTemplate, setNotesTemplate] = useState(template?.notesTemplate ?? '')
  const [variants, setVariants] = useState<TemplateDraftVariant[]>(() => (
    template ? groupTemplateVariants(template.variants) : [createEmptyTemplateDraftVariant()]
  ))
  const [expandedVariantIndex, setExpandedVariantIndex] = useState<number | null>(0)
  const [error, setError] = useState<string | null>(null)
  const flattenedVariants = flattenTemplateDraftVariants(variants)
  const hasBlankVariantNames = variants.some((variant) => !variant.name.trim())
  const hasIncompleteItems = variants.some((variant) => variant.items.some((item) => !item.libraryFileId))
  const hasItemsWithoutQuantities = variants.some((variant) => variant.items.some((item) => item.libraryFileId && getTemplateDraftItemTotalQuantity(item) === 0))
  const hasEmptyVariants = flattenedVariants.some((variant) => variant.items.length === 0)

  const save = useMutation({
    mutationFn: (body: OrderTemplateCreateInput | OrderTemplateUpdateInput) => {
      if (template) {
        return apiFetch(`/api/plugins/orders/templates/${template.id}`, { method: 'PATCH', body })
      }
      return apiFetch('/api/plugins/orders/templates', { method: 'POST', body })
    },
    onSuccess: onSaved,
    onError: (mutationError) => setError((mutationError as Error).message)
  })

  const updateVariant = (index: number, next: Partial<TemplateDraftVariant>) => {
    setVariants((current) => current.map((variant, variantIndex) => (variantIndex === index ? { ...variant, ...next } : variant)))
  }

  const updateVariantItems = (variantIndex: number, nextItems: TemplateDraftItem[]) => {
    setVariants((current) => current.map((variant, currentIndex) => (
      currentIndex === variantIndex
        ? { ...variant, items: nextItems }
        : variant
    )))
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', md: 920 } }}>
        <Typography level="h4">{isEditing ? 'Edit template' : 'New template'}</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={2} sx={{ minWidth: 0 }}>
            <DialogSection title="Template details">
              <Stack spacing={1.25}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>Name</FormLabel>
                    <Input value={name} onChange={(event) => setName(event.target.value)} />
                  </FormControl>
                  <FormControl sx={{ width: { xs: '100%', sm: 180 } }}>
                    <FormLabel>Code</FormLabel>
                    <Input value={code} onChange={(event) => setCode(event.target.value)} />
                  </FormControl>
                </Stack>

                <FormControl>
                  <FormLabel>Description</FormLabel>
                  <Textarea minRows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
                </FormControl>

                <FormControl>
                  <FormLabel>Default order notes</FormLabel>
                  <Textarea minRows={3} value={notesTemplate} onChange={(event) => setNotesTemplate(event.target.value)} />
                </FormControl>
              </Stack>
            </DialogSection>

            <DialogSection title="Variants">
              <Stack spacing={1}>
                <AccordionGroup sx={{ gap: 1 }}>
                  {variants.map((variant, variantIndex) => {
                    const variantCopyCount = variant.items.reduce((sum, item) => sum + getTemplateDraftItemTotalQuantity(item), 0)
                    return (
                      <Accordion
                        key={variant.id}
                        expanded={expandedVariantIndex === variantIndex}
                        onChange={(_event, expanded) => setExpandedVariantIndex(expanded ? variantIndex : null)}
                      >
                        <AccordionSummary indicator={<KeyboardArrowDownRoundedIcon />}>
                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} sx={{ width: '100%', pr: 1 }}>
                            <Typography level="title-sm">{variant.name.trim() || `Variant ${variantIndex + 1}`}</Typography>
                            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                              <Chip size="sm" variant="soft">{variant.items.length} print{variant.items.length === 1 ? '' : 's'}</Chip>
                              <Chip size="sm" variant="soft">{variantCopyCount} copies</Chip>
                            </Stack>
                          </Stack>
                        </AccordionSummary>
                        <AccordionDetails>
                          <Stack spacing={1.25}>
                            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ xs: 'stretch', md: 'flex-end' }}>
                              <FormControl sx={{ flex: 1 }}>
                                <FormLabel>Variant name</FormLabel>
                                <Input
                                  value={variant.name}
                                  onChange={(event) => updateVariant(variantIndex, { name: event.target.value })}
                                />
                              </FormControl>
                              <Box sx={{ display: 'flex', justifyContent: { xs: 'flex-end', md: 'flex-end' } }}>
                                <IconButton
                                  color="danger"
                                  variant="plain"
                                  disabled={variants.length <= 1}
                                  onClick={() => {
                                    setVariants((current) => current.filter((_value, index) => index !== variantIndex))
                                    setExpandedVariantIndex((current) => {
                                      if (current == null) return current
                                      if (current === variantIndex) return Math.max(0, variantIndex - 1)
                                      return current > variantIndex ? current - 1 : current
                                    })
                                  }}
                                >
                                  <DeleteRoundedIcon />
                                </IconButton>
                              </Box>
                            </Stack>

                            <Stack spacing={1}>
                              {variant.items.map((item, itemIndex) => (
                                <TemplateDraftItemEditor
                                  key={item.id}
                                  item={item}
                                  files={files}
                                  onChange={(next) => updateVariantItems(
                                    variantIndex,
                                    variant.items.map((currentItem, currentIndex) => (
                                      currentIndex === itemIndex
                                        ? { ...currentItem, ...next }
                                        : currentItem
                                    ))
                                  )}
                                  onRemove={() => updateVariantItems(
                                    variantIndex,
                                    variant.items.filter((_value, currentIndex) => currentIndex !== itemIndex)
                                  )}
                                  canRemove={variant.items.length > 1}
                                />
                              ))}

                              <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                                <Button
                                  size="sm"
                                  variant="soft"
                                  startDecorator={<AddRoundedIcon />}
                                  onClick={() => updateVariantItems(variantIndex, [...variant.items, createEmptyTemplateDraftItem()])}
                                >
                                  Add print
                                </Button>
                              </Box>
                            </Stack>
                          </Stack>
                        </AccordionDetails>
                      </Accordion>
                    )
                  })}
                </AccordionGroup>

                <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <Button
                    size="sm"
                    variant="soft"
                    startDecorator={<AddRoundedIcon />}
                    onClick={() => setVariants((current) => {
                      const next = [...current, createEmptyTemplateDraftVariant(`Variant ${current.length + 1}`)]
                      setExpandedVariantIndex(next.length - 1)
                      return next
                    })}
                  >
                    Add variant
                  </Button>
                </Box>
              </Stack>
            </DialogSection>

            {error && <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{error}</Alert>}
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!name.trim() || hasBlankVariantNames || hasIncompleteItems || hasItemsWithoutQuantities || flattenedVariants.length === 0 || hasEmptyVariants}
            loading={save.isPending}
            onClick={() => save.mutate({
              name,
              code: code || null,
              description: description || null,
              notesTemplate: notesTemplate || null,
              variants: flattenedVariants
            })}
          >
            {isEditing ? 'Save template' : 'Create template'}
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function EditOrderDialog({
  order,
  onClose,
  onSaved,
  pending
}: {
  order: Order
  onClose: () => void
  onSaved: (body: OrderUpdateInput) => void
  pending: boolean
}) {
  const [name, setName] = useState(order.name)
  const [notes, setNotes] = useState(order.notes ?? '')

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 560, width: '100%' }}>
        <Typography level="h4">Edit order</Typography>
        <Stack spacing={1.5}>
          <FormControl>
            <FormLabel>Order name</FormLabel>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </FormControl>
          <FormControl>
            <FormLabel>Notes</FormLabel>
            <Textarea minRows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </FormControl>
        </Stack>

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button
            loading={pending}
            disabled={!name.trim()}
            onClick={() => onSaved({
              name,
              notes: notes || null
            })}
          >
            Save order
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}

export function TemplateDraftItemEditor({
  item,
  files,
  onChange,
  onRemove,
  canRemove
}: {
  item: TemplateDraftItem
  files: LibraryFile[]
  onChange: (next: Partial<TemplateDraftItem>) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const platesQuery = useQuery<ThreeMfIndex>({
    queryKey: ['library-plates', item.libraryFileId],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`/api/library/${item.libraryFileId}/plates`, { signal }),
    enabled: Boolean(item.libraryFileId),
    staleTime: 60_000
  })

  const plates = useMemo(
    () => platesQuery.data?.plates ?? [],
    [platesQuery.data]
  )
  const selectedFile = item.libraryFileId
    ? files.find((file) => file.id === item.libraryFileId) ?? null
    : null
  const selectedFileLabel = item.libraryFileName
    ? formatLibraryFileName(item.libraryFileName)
    : 'No library file selected'
  const hasIndexedPlates = item.libraryFileId && plates.length > 0

  return (
    <>
      <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'md', minWidth: 0, overflow: 'hidden' }}>
        <Stack spacing={1} sx={{ minWidth: 0 }}>
          <FormControl sx={{ flex: 1 }}>
            <FormLabel>Library file</FormLabel>
            {selectedFile ? (
              <Sheet variant="soft" sx={{ p: 1, borderRadius: 'md', minWidth: 0 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ xs: 'stretch', md: 'center' }} sx={{ minWidth: 0 }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <LibraryFileRow
                      file={selectedFile}
                      onClick={() => setPickerOpen(true)}
                      hideMetadataTags
                    />
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: { xs: 'flex-start', md: 'flex-end' }, flexShrink: 0 }}>
                    <Button size="sm" variant="soft" onClick={() => setPickerOpen(true)}>
                      Change file
                    </Button>
                  </Box>
                </Stack>
              </Sheet>
            ) : (
              <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography level="body-sm">{selectedFileLabel}</Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {item.libraryFileName
                        ? 'This file is currently missing from the available library listing.'
                        : 'Browse the library to choose a printer-ready G-code or G-code 3MF file.'}
                    </Typography>
                  </Box>
                  <Button size="sm" variant="soft" onClick={() => setPickerOpen(true)}>
                    {item.libraryFileId ? 'Change file' : 'Browse library'}
                  </Button>
                </Stack>
              </Sheet>
            )}
          </FormControl>

          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <FormControl sx={{ flex: 1, minWidth: 0 }}>
              {!item.libraryFileId ? (
                <>
                  <FormLabel>Plates</FormLabel>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Typography level="body-sm">Choose a library file first</Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      Plate quantities appear after you pick a printer-ready file.
                    </Typography>
                      </Sheet>
                </>
              ) : hasIndexedPlates ? (
                <>
                  <FormLabel>Plates</FormLabel>
                  <Stack spacing={0.75}>
                    {plates.map((plate) => (
                      <Sheet key={plate.index} variant="soft" sx={{ p: 1, borderRadius: 'md' }}>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <LibraryPlatePreview
                              fileId={item.libraryFileId}
                              plate={plate}
                              size={56}
                              noWrap={false}
                              subtitleFallback={formatTemplateDraftPlateSummary(plate)}
                            />
                          </Box>
                          <FormControl sx={{ width: { xs: '100%', sm: 180 }, alignSelf: { xs: 'stretch', sm: 'flex-end' } }}>
                            <FormLabel>Qty</FormLabel>
                            <Input
                              type="number"
                              value={String(getTemplateDraftItemQuantity(item, plate.index))}
                              onChange={(event) => onChange({
                                plateQuantities: setTemplateDraftItemPlateQuantity(
                                  item,
                                  plate.index,
                                  Number(event.target.value) || 0
                                ).plateQuantities
                              })}
                            />
                          </FormControl>
                        </Stack>
                      </Sheet>
                    ))}
                  </Stack>
                  <Typography level="body-xs" textColor="text.tertiary">
                    Set a quantity above zero for each plate you want this template to require.
                  </Typography>
                </>
              ) : (
                <>
                  <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
                    <FormLabel sx={{ mb: 0 }}>Plates</FormLabel>
                    <Button
                      size="sm"
                      variant="plain"
                      startDecorator={<AddRoundedIcon />}
                      onClick={() => onChange({ plateQuantities: addTemplateDraftItemPlate(item).plateQuantities })}
                    >
                      Add plate
                    </Button>
                  </Stack>
                  <Stack spacing={0.75}>
                    {item.plateQuantities.map((entry, entryIndex) => (
                      <Sheet key={`${entry.plate}:${entryIndex}`} variant="soft" sx={{ p: 1, borderRadius: 'md' }}>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
                          <FormControl sx={{ flex: 1, minWidth: 0 }}>
                            <FormLabel>Plate</FormLabel>
                            <Input
                              type="number"
                              value={String(entry.plate)}
                              onChange={(event) => onChange({
                                plateQuantities: renameTemplateDraftItemPlate(
                                  item,
                                  entry.plate,
                                  Number(event.target.value) || 1
                                ).plateQuantities
                              })}
                            />
                          </FormControl>
                          <FormControl sx={{ width: { xs: '100%', sm: 180 }, alignSelf: { xs: 'stretch', sm: 'flex-end' } }}>
                            <FormLabel>Qty</FormLabel>
                            <Input
                              type="number"
                              value={String(entry.quantity)}
                              onChange={(event) => onChange({
                                plateQuantities: setTemplateDraftItemPlateQuantity(
                                  item,
                                  entry.plate,
                                  Number(event.target.value) || 0
                                ).plateQuantities
                              })}
                            />
                          </FormControl>
                          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <IconButton
                              color="danger"
                              variant="plain"
                              disabled={item.plateQuantities.length <= 1}
                              onClick={() => onChange({
                                plateQuantities: removeTemplateDraftItemPlate(item, entry.plate).plateQuantities
                              })}
                            >
                              <DeleteRoundedIcon />
                            </IconButton>
                          </Box>
                        </Stack>
                      </Sheet>
                    ))}
                  </Stack>
                </>
              )}
            </FormControl>
          </Stack>

          <FormControl>
            <FormLabel>Notes</FormLabel>
            <Input value={item.notes} onChange={(event) => onChange({ notes: event.target.value })} />
          </FormControl>

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <IconButton color="danger" variant="plain" disabled={!canRemove} onClick={onRemove}>
              <DeleteRoundedIcon />
            </IconButton>
          </Box>
        </Stack>
      </Sheet>

      {pickerOpen && (
        <TemplateLibraryFilePickerDialog
          files={files}
          selectedFileId={item.libraryFileId}
          onClose={() => setPickerOpen(false)}
          onPick={(file) => {
            onChange({
              libraryFileId: file.id,
              libraryFileName: file.name,
              plateQuantities: createEmptyTemplateDraftItem().plateQuantities
            })
            setPickerOpen(false)
          }}
        />
      )}
    </>
  )
}

export function TemplateLibraryFilePickerDialog({
  files,
  selectedFileId,
  onClose,
  onPick
}: {
  files: LibraryFile[]
  selectedFileId: string
  onClose: () => void
  onPick: (file: LibraryFile) => void
}) {
  const selectedFile = selectedFileId ? files.find((file) => file.id === selectedFileId) ?? null : null
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(selectedFile?.folderId ?? null)
  const [bridgeId, setBridgeId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<LibraryViewMode>('list')
  const [sort, setSort] = useState<LibrarySort>({ key: 'name', dir: 'asc' })
  const browseQuery = useQuery<LibraryBrowseResponse>({
    queryKey: ['library-browse', 'orders-picker', currentFolderId ?? 'root', bridgeId ?? 'none'],
    queryFn: () => {
      const params = new URLSearchParams()
      if (currentFolderId) params.set('folderId', currentFolderId)
      if (bridgeId) params.set('bridgeId', bridgeId)
      const search = params.toString()
      return apiFetch<LibraryBrowseResponse>(`/api/library/browse${search ? `?${search}` : ''}`)
    },
    staleTime: 60_000
  })
  const browseData = browseQuery.data
  const resolvedBridgeId = browseData?.activeBridgeId ?? bridgeId
  const foldersQuery = useQuery<{ folders: LibraryFolder[] }>({
    queryKey: ['library-folders', 'orders-picker', resolvedBridgeId ?? 'none'],
    queryFn: () => {
      const params = new URLSearchParams()
      if (resolvedBridgeId) params.set('bridgeId', resolvedBridgeId)
      const search = params.toString()
      return apiFetch<{ folders: LibraryFolder[] }>(`/api/library/folders${search ? `?${search}` : ''}`)
    },
    staleTime: 60_000
  })
  const bridgeRootMode = browseData?.mode === 'bridge-root'
  const bridgeEntries = browseData?.bridgeEntries ?? []
  const bridgeFolders = bridgeEntries.map((bridge) => ({ id: toBridgeFolderId(bridge.id), name: bridge.name, parentId: null } satisfies LibraryFolder))

  const allFolders = useMemo(
    () => foldersQuery.data?.folders ?? [],
    [foldersQuery.data?.folders]
  )
  const childFolders = useMemo(
    () => bridgeRootMode ? bridgeFolders : (browseData?.folders ?? []),
    [bridgeFolders, bridgeRootMode, browseData?.folders]
  )
  const visibleFiles = useMemo(
    () => browseData?.files ?? [],
    [browseData?.files]
  )
  const activeBridgeName = resolvedBridgeId ? bridgeEntries.find((bridge) => bridge.id === resolvedBridgeId)?.name ?? null : null
  const breadcrumb = useMemo(
    () => buildLibraryBreadcrumb(allFolders, currentFolderId, resolvedBridgeId, activeBridgeName, {
      showRoot: bridgeEntries.length !== 1
    }),
    [activeBridgeName, allFolders, bridgeEntries.length, currentFolderId, resolvedBridgeId]
  )
  const pickerError = (browseQuery.error ?? foldersQuery.error) as Error | undefined

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', md: 920 } }}>
        <Typography level="h4">Choose library file</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={2} sx={{ minHeight: 420, minWidth: 0 }}>
            <Typography level="body-sm" textColor="text.secondary">
              Browse folders and pick the printer-ready file this order template should require.
            </Typography>
            <DialogSection
              title="Location"
              description={selectedFile ? `Current selection: ${formatLibraryFileName(selectedFile.name)}` : undefined}
            >
              <Stack spacing={1.25}>
                {bridgeRootMode && (
                  <Alert color="neutral" variant="outlined" startDecorator={<InfoOutlinedIcon />}>
                    Select a library source to browse printable files.
                  </Alert>
                )}

                <LibraryBreadcrumb
                  crumbs={breadcrumb}
                  onNavigate={(folderEntryId) => {
                    if (folderEntryId === null) {
                      setCurrentFolderId(null)
                      setBridgeId(null)
                      return
                    }
                    if (folderEntryId && isBridgeFolderId(folderEntryId)) {
                      setBridgeId(fromBridgeFolderId(folderEntryId))
                      setCurrentFolderId(null)
                      return
                    }
                    setCurrentFolderId(folderEntryId)
                  }}
                />

                <LibraryToolbar
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  sort={sort}
                  onSortChange={setSort}
                />

                {pickerError && <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{pickerError.message}</Alert>}
              </Stack>
            </DialogSection>

            <DialogSection title="Files">
              <LibraryBrowser
                folders={childFolders}
                files={visibleFiles}
                viewMode={viewMode}
                sort={sort}
                surfaceStyle="dialog"
                onFolderOpen={(folder) => {
                  if (isBridgeFolderId(folder.id)) {
                    setBridgeId(fromBridgeFolderId(folder.id))
                    setCurrentFolderId(null)
                    return
                  }
                  setCurrentFolderId(folder.id)
                }}
                onFilePick={onPick}
                isFilePickable={(file) => isDirectPrintableFileName(file.name) || isUnslicedThreeMfFile(file)}
                getFileDisabledReason={(file) => (
                  isDirectPrintableFileName(file.name) || isUnslicedThreeMfFile(file)
                    ? null
                    : 'Only G-code, G-code 3MF, or project 3MF files can be added to orders.'
                )}
                emptyState={
                  <EmptyState
                    icon={<FolderOpenRoundedIcon />}
                    title={bridgeRootMode ? 'No bridges connected' : currentFolderId ? 'This folder is empty' : 'No files in the library yet'}
                    description={
                      bridgeRootMode
                        ? 'Connect a bridge to browse its files.'
                        : currentFolderId
                        ? 'Choose another folder or upload a printer-ready file here from the Library page.'
                        : 'Upload printer-ready files in the Library page, then add them to this template.'
                    }
                  />
                }
              />
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function OrderDialog({
  templates,
  initialTemplateId,
  onClose,
  onSaved
}: {
  templates: OrderTemplate[]
  initialTemplateId: string
  onClose: () => void
  onSaved: () => void
}) {
  const initialTemplate = templates.find((template) => template.id === initialTemplateId) ?? templates[0] ?? null
  const [templateId, setTemplateId] = useState(initialTemplate?.id ?? '')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState(initialTemplate?.notesTemplate ?? '')
  const [variantQuantities, setVariantQuantities] = useState<Record<string, number>>(() => createInitialOrderVariantQuantities(initialTemplate))
  const [printFilamentOverrides, setPrintFilamentOverrides] = useState<Record<string, ThreeMfProjectFilament[]>>({})
  const [colorPickerTarget, setColorPickerTarget] = useState<{
    templatePrintId: string
    variantCopyIndex: number
    filamentId: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selectedTemplate = templates.find((template) => template.id === templateId) ?? null
  const selectedVariants = buildSelectedOrderVariantSelections(selectedTemplate, variantQuantities)
  const requiresVariantSelection = (selectedTemplate?.variants.length ?? 0) > 1
  const selectedTemplatePrints = useMemo(
    () => buildSelectedTemplatePrints(selectedTemplate, variantQuantities),
    [selectedTemplate, variantQuantities]
  )
  const selectedTemplatePrintFileIds = useMemo(
    () => Array.from(new Set(
      selectedTemplatePrints.flatMap(({ item }) => item.libraryFileId && item.fileAvailable ? [item.libraryFileId] : [])
    )).sort(),
    [selectedTemplatePrints]
  )
  const templateFileIndexesQuery = useQuery<Record<string, ThreeMfIndex>>({
    queryKey: ['orders', 'template-filaments', selectedTemplate?.id ?? null, selectedTemplatePrintFileIds],
    queryFn: async ({ signal }) => Object.fromEntries(
      await Promise.all(
        selectedTemplatePrintFileIds.map(async (fileId) => [
          fileId,
          await apiFetch<ThreeMfIndex>(`/api/library/${fileId}/plates`, { signal })
        ] as const)
      )
    ),
    enabled: selectedTemplatePrintFileIds.length > 0,
    staleTime: 60_000
  })
  const selectedTemplatePrintFilaments = useMemo<SelectedTemplatePrintWithFilaments[]>(
    () => selectedTemplatePrints.map((templatePrint) => {
      const fileIndex = templatePrint.item.libraryFileId
        ? templateFileIndexesQuery.data?.[templatePrint.item.libraryFileId]
        : undefined

      return {
        ...templatePrint,
        plateInfo: fileIndex?.plates.find((entry) => entry.index === templatePrint.item.plate),
        projectFilaments: buildTemplatePrintProjectFilaments(templatePrint.item, fileIndex)
      }
    }).filter((templatePrint) => templatePrint.projectFilaments.length > 0),
    [selectedTemplatePrints, templateFileIndexesQuery.data]
  )
  const selectedOrderPrintFilamentOverrides = useMemo(
    () => buildOrderPrintFilamentOverrides(selectedTemplatePrintFilaments, printFilamentOverrides),
    [printFilamentOverrides, selectedTemplatePrintFilaments]
  )
  const isFilamentMappingLoading = selectedTemplatePrintFileIds.length > 0 && templateFileIndexesQuery.isLoading
  const filamentMappingError = templateFileIndexesQuery.error as Error | null

  useEffect(() => {
    setPrintFilamentOverrides((current) => {
      const next: Record<string, ThreeMfProjectFilament[]> = {}
      for (const templatePrint of selectedTemplatePrintFilaments) {
        for (let variantCopyIndex = 0; variantCopyIndex < templatePrint.variantQuantity; variantCopyIndex += 1) {
          const copyKey = buildTemplatePrintVariantCopyKey(templatePrint.item.id, variantCopyIndex)
          next[copyKey] = mergeProjectFilamentDrafts(
            templatePrint.projectFilaments,
            current[copyKey]
          )
        }
      }
      return next
    })
  }, [selectedTemplatePrintFilaments])

  const activeColorPickerTarget = useMemo(() => {
    if (!colorPickerTarget) return null
    const templatePrint = selectedTemplatePrintFilaments.find((entry) => entry.item.id === colorPickerTarget.templatePrintId)
    if (!templatePrint) return null
    const sourceFilament = templatePrint.projectFilaments.find((entry) => entry.id === colorPickerTarget.filamentId)
    if (!sourceFilament) return null
    const copyKey = buildTemplatePrintVariantCopyKey(templatePrint.item.id, colorPickerTarget.variantCopyIndex)
    const selectedFilament = printFilamentOverrides[copyKey]?.find((entry) => entry.id === sourceFilament.id)
      ?? sourceFilament

    return {
      templatePrint,
      copyKey,
      variantCopyIndex: colorPickerTarget.variantCopyIndex,
      sourceFilament,
      selectedFilament
    }
  }, [colorPickerTarget, printFilamentOverrides, selectedTemplatePrintFilaments])

  const save = useMutation({
    mutationFn: (body: OrderCreateInput) => apiFetch('/api/plugins/orders/orders', { method: 'POST', body }),
    onSuccess: onSaved,
    onError: (mutationError) => setError((mutationError as Error).message)
  })

  return (
    <>
      <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 560 } }}>
        <Typography level="h4">New order</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={2}>
          <DialogSection title="Order details">
            <Stack spacing={1.25}>
              <FormControl>
                <FormLabel>Template</FormLabel>
                <Select
                  value={templateId || null}
                  onChange={(_event, value) => {
                    const nextTemplate = templates.find((template) => template.id === value) ?? null
                    setTemplateId(value ?? '')
                    setNotes(nextTemplate?.notesTemplate ?? '')
                    setVariantQuantities(createInitialOrderVariantQuantities(nextTemplate))
                    setPrintFilamentOverrides({})
                    setColorPickerTarget(null)
                  }}
                >
                  {templates.map((template) => (
                    <Option key={template.id} value={template.id}>{template.name}</Option>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>Order name</FormLabel>
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </FormControl>
              <FormControl>
                <FormLabel>Notes</FormLabel>
                <Textarea minRows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </FormControl>
            </Stack>
          </DialogSection>

          {requiresVariantSelection && selectedTemplate && (
            <DialogSection
              title="Variants"
              description="Choose one or more variants and how many of each this order should include."
            >
              <Stack spacing={1}>
                {selectedTemplate.variants.map((variant) => {
                  const quantity = variantQuantities[variant.id] ?? 0
                  const selected = quantity > 0
                  return (
                    <Sheet key={variant.id} variant="outlined" sx={{ p: 1.25, borderRadius: 'md' }}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} alignItems={{ xs: 'stretch', sm: 'center' }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Checkbox
                              checked={selected}
                              onChange={(_event) => setVariantQuantities((current) => {
                                const currentQuantity = current[variant.id] ?? 0
                                return {
                                  ...current,
                                  [variant.id]: currentQuantity > 0 ? 0 : 1
                                }
                              })}
                            />
                            <Box sx={{ minWidth: 0 }}>
                              <Typography level="title-sm">{variant.name}</Typography>
                              <Typography level="body-xs" textColor="text.tertiary">
                                {variant.items.length} plate group{variant.items.length === 1 ? '' : 's'} · {countTemplateVariantCopies(variant)} copies per selection
                              </Typography>
                            </Box>
                          </Stack>
                        </Box>
                        <FormControl sx={{ width: { xs: '100%', sm: 120 } }}>
                          <FormLabel>Qty</FormLabel>
                          <Input
                            type="number"
                            disabled={!selected}
                            value={selected ? String(quantity) : ''}
                            onChange={(event) => setVariantQuantities((current) => ({
                              ...current,
                              [variant.id]: Math.max(0, Math.trunc(Number(event.target.value) || 0))
                            }))}
                          />
                        </FormControl>
                      </Stack>
                    </Sheet>
                  )
                })}
              </Stack>
            </DialogSection>
          )}

          {selectedTemplatePrints.length > 0 && (
            <DialogSection
              title="Color mapping"
              description="Keep each model's material the same and choose the color you want shown later when assigning AMS trays."
            >
              <Stack spacing={1}>
                {isFilamentMappingLoading && (
                  <Typography level="body-sm" textColor="text.tertiary">
                    Loading model materials...
                  </Typography>
                )}

                {!isFilamentMappingLoading && filamentMappingError && (
                  <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                    {filamentMappingError.message}
                  </Alert>
                )}

                {!isFilamentMappingLoading && !filamentMappingError && selectedTemplatePrintFilaments.length === 0 && (
                  <Typography level="body-sm" textColor="text.tertiary">
                    No filament metadata is available for the selected prints.
                  </Typography>
                )}

                {!isFilamentMappingLoading && !filamentMappingError && selectedTemplatePrintFilaments.map((templatePrint) => (
                  <Sheet key={templatePrint.item.id} variant="outlined" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1.25} sx={{ minWidth: 0 }}>
                      <Box sx={{ minWidth: 0 }}>
                        {templatePrint.item.libraryFileId ? (
                          <LibraryPlatePreview
                            fileId={templatePrint.item.libraryFileId}
                            plate={templatePrint.plateInfo}
                            size={56}
                            subtitleFallback={`${templatePrint.item.quantity * templatePrint.variantQuantity} cop${templatePrint.item.quantity * templatePrint.variantQuantity === 1 ? 'y' : 'ies'}`}
                            noWrap={false}
                          />
                        ) : (
                          <Stack spacing={0.25}>
                            <Typography level="title-sm">{formatLibraryFileName(templatePrint.item.libraryFileName)}</Typography>
                            <Typography level="body-xs" textColor="text.tertiary">Plate {templatePrint.item.plate}</Typography>
                          </Stack>
                        )}
                        <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.75 }}>
                          {templatePrint.variantName} · {templatePrint.item.quantity * templatePrint.variantQuantity} cop{templatePrint.item.quantity * templatePrint.variantQuantity === 1 ? 'y' : 'ies'}
                        </Typography>
                      </Box>

                      <Box
                        sx={{
                          display: 'grid',
                          gap: 1,
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
                          minWidth: 0
                        }}
                      >
                        {Array.from({ length: templatePrint.variantQuantity }, (_unused, variantCopyIndex) => {
                          const copyKey = buildTemplatePrintVariantCopyKey(templatePrint.item.id, variantCopyIndex)

                          return (
                            <Stack key={copyKey} spacing={0.75} sx={{ minWidth: 0 }}>
                              {templatePrint.variantQuantity > 1 && (
                                <Typography level="body-xs" textColor="text.tertiary">
                                  Copy {variantCopyIndex + 1}
                                </Typography>
                              )}

                              {templatePrint.projectFilaments.map((sourceFilament) => {
                                const selectedFilament = printFilamentOverrides[copyKey]?.find((filament) => filament.id === sourceFilament.id)
                                  ?? sourceFilament
                                const selectedColorLabel = formatProjectFilamentColorLabel(selectedFilament) ?? selectedFilament.color?.toUpperCase() ?? 'Choose color'
                                const hasCustomColor = (selectedFilament.color ?? null) !== (sourceFilament.color ?? null)

                                return (
                                  <Sheet key={`${copyKey}-${sourceFilament.id}`} variant="soft" sx={{ px: 1, py: 0.75, borderRadius: 'md' }}>
                                    <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ minWidth: 0 }}>
                                      <OverflowTooltipText
                                        level="body-xs"
                                        textColor="text.tertiary"
                                        noWrap
                                        sx={{ flex: '1 1 0', minWidth: 0 }}
                                        text={sourceFilament.filamentName?.trim() || sourceFilament.filamentType?.trim() || `Filament #${sourceFilament.id}`}
                                      />
                                      <Button
                                        size="sm"
                                        variant={hasCustomColor ? 'soft' : 'outlined'}
                                        color={hasCustomColor ? 'primary' : 'neutral'}
                                        onClick={() => setColorPickerTarget({
                                          templatePrintId: templatePrint.item.id,
                                          variantCopyIndex,
                                          filamentId: sourceFilament.id
                                        })}
                                        sx={{ minWidth: { xs: 116, sm: 140 }, justifyContent: 'flex-start', flexShrink: 0 }}
                                        startDecorator={(
                                          <Box
                                            sx={{
                                              width: 14,
                                              height: 14,
                                              borderRadius: '50%',
                                              backgroundColor: selectedFilament.color ?? 'var(--joy-palette-neutral-700)',
                                              border: '1px solid var(--joy-palette-neutral-700)'
                                            }}
                                          />
                                        )}
                                      >
                                        {selectedColorLabel}
                                      </Button>
                                    </Stack>
                                  </Sheet>
                                )
                              })}
                            </Stack>
                          )
                        })}
                      </Box>
                    </Stack>
                  </Sheet>
                ))}
              </Stack>
            </DialogSection>
          )}

          {error && <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{error}</Alert>}
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.isPending}
            disabled={
              !name.trim()
              || (requiresVariantSelection && selectedVariants.length === 0)
              || isFilamentMappingLoading
              || filamentMappingError != null
            }
            onClick={() => save.mutate({
              templateId,
              name,
              notes: notes || null,
              printFilamentOverrides: selectedOrderPrintFilamentOverrides.length > 0
                ? selectedOrderPrintFilamentOverrides
                : undefined,
              variants: selectedVariants.length > 0 ? selectedVariants : undefined
            })}
          >
            Create order
          </Button>
        </Stack>
      </ScrollableModalDialog>
      </Modal>

      {activeColorPickerTarget && (
        <OrderColorPickerModal
          templatePrint={activeColorPickerTarget.templatePrint}
          variantCopyIndex={activeColorPickerTarget.variantCopyIndex}
          sourceFilament={activeColorPickerTarget.sourceFilament}
          selectedFilament={activeColorPickerTarget.selectedFilament}
          onClose={() => setColorPickerTarget(null)}
          onPick={(hex) => setPrintFilamentOverrides((current) => ({
            ...current,
            [activeColorPickerTarget.copyKey]: updateProjectFilamentDraft(
              current[activeColorPickerTarget.copyKey] ?? activeColorPickerTarget.templatePrint.projectFilaments,
              activeColorPickerTarget.sourceFilament.id,
              (filament) => ({
                ...filament,
                color: hex
              })
            )
          }))}
          onReset={() => {
            setPrintFilamentOverrides((current) => ({
              ...current,
              [activeColorPickerTarget.copyKey]: updateProjectFilamentDraft(
                current[activeColorPickerTarget.copyKey] ?? activeColorPickerTarget.templatePrint.projectFilaments,
                activeColorPickerTarget.sourceFilament.id,
                () => normalizeProjectFilamentDraft(activeColorPickerTarget.sourceFilament)
              )
            }))
            setColorPickerTarget(null)
          }}
        />
      )}
    </>
  )
}

export function OrderColorPickerModal({
  templatePrint,
  variantCopyIndex,
  sourceFilament,
  selectedFilament,
  onClose,
  onPick,
  onReset
}: {
  templatePrint: SelectedTemplatePrintWithFilaments
  variantCopyIndex: number
  sourceFilament: ThreeMfProjectFilament
  selectedFilament: ThreeMfProjectFilament
  onClose: () => void
  onPick: (hex: string) => void
  onReset: () => void
}) {
  const swatches = resolveProjectFilamentColorOptions(selectedFilament).swatches
  const selectedHex = toColorPickerValue(selectedFilament.color)
  const sourceColorLabel = formatProjectFilamentColorLabel(sourceFilament) ?? sourceFilament.color?.toUpperCase() ?? 'Unspecified'
  const selectedColorLabel = formatProjectFilamentColorLabel(selectedFilament) ?? selectedFilament.color?.toUpperCase() ?? 'Choose color'

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 420 } }}>
        <Typography level="h4">Choose color</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {templatePrint.item.libraryFileName} · Plate {templatePrint.item.plate}
          {templatePrint.variantQuantity > 1 ? ` · Copy ${variantCopyIndex + 1}` : ''}
        </Typography>

        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={1.25}>
            <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
              <Stack spacing={0.75}>
                <Typography level="body-xs" textColor="text.tertiary">
                  {sourceFilament.filamentName?.trim() || sourceFilament.filamentType?.trim() || `Filament #${sourceFilament.id}`}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: '1 1 0', minWidth: 0 }}>
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        backgroundColor: sourceFilament.color ?? 'var(--joy-palette-neutral-700)',
                        border: '1px solid var(--joy-palette-neutral-700)',
                        flexShrink: 0
                      }}
                    />
                    <Typography level="body-sm" noWrap>{sourceColorLabel}</Typography>
                  </Stack>
                  <Typography level="body-xs" textColor="text.tertiary">to</Typography>
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: '1 1 0', minWidth: 0, justifyContent: 'flex-end' }}>
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        backgroundColor: selectedFilament.color ?? 'var(--joy-palette-neutral-700)',
                        border: '1px solid var(--joy-palette-neutral-700)',
                        flexShrink: 0
                      }}
                    />
                    <Typography level="body-sm" noWrap>{selectedColorLabel}</Typography>
                  </Stack>
                </Stack>
              </Stack>
            </Sheet>

            <Stack direction="row" spacing={1} alignItems="center">
              <Input
                size="sm"
                type="color"
                value={selectedHex}
                onChange={(event) => onPick(event.target.value)}
                sx={{ width: 56, '--Input-paddingInline': '0.25rem' }}
              />
              <Input
                size="sm"
                value={selectedFilament.color ?? ''}
                placeholder="#RRGGBB"
                onChange={(event) => onPick(event.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>

            <ColorSwatchPicker
              title={describeProjectFilamentColorOptions(selectedFilament)}
              swatches={swatches}
              selectedHex={selectedHex}
              onPick={onPick}
            />
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onReset}>Use model color</Button>
          <Stack direction="row" spacing={1}>
            <Button variant="plain" onClick={onClose}>Done</Button>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
