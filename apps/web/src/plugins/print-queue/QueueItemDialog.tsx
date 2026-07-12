/**
 * Rich create/edit dialog for a queued print. Mirrors the Print dialog's control:
 * a visual plate picker, print settings, and material mapping that adapts to the
 * target — a specific printer reuses the Print dialog's AMS tray mapper
 * ({@link PrinterMapping}), while "any printer" maps generally via the filament
 * library / custom entry ({@link QueueMaterialEditor}). Used both to add new items
 * and to edit a queued one before it dispatches.
 */
import { useEffect, useMemo, useState } from 'react'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import {
  Button,
  DialogActions,
  DialogTitle,
  FormControl,
  FormLabel,
  Input,
  Modal,
  Stack,
  Typography
} from '@mui/joy'
import { useQuery } from '@tanstack/react-query'
import {
  evaluateQueueMatch,
  getPrinterPrintStartOptions,
  isPrinterModelCompatible,
  loadedSlotsFromStatus,
  queuePrintOptionsSchema,
  type PrinterModel,
  type PrinterPrintStartOptions,
  type PrinterStatus,
  type Printer,
  type QueueItem,
  type QueueOrderLink,
  type QueuePrintOptions,
  type QueueRequiredFilament,
  type QueueTarget,
  type ThreeMfIndex,
  type ThreeMfProjectFilament
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { DialogSection } from '../../components/DialogSection'
import { LibraryPlateCardPicker } from '../../components/LibraryPlateSelect'
import { PrintObjectsSection } from '../../components/library/PrintObjectsSection'
import { PrintStartOptionsFields } from '../../components/library/PrintStartOptionsFields'
import { plateHasSliceData } from '../../lib/sliceProfileMatching'
import { buildLibraryResourceBasePath, visibleMappingFilaments } from '../../lib/libraryViewHelpers'
import { mergePrintStartOptions } from '../../lib/printStartOptions'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import { toast } from '../../lib/toast'
import { useAddQueueItem, useUpdateQueueItem } from './api'
import { QueueMaterialEditor } from './QueueMaterialEditor'
import { QueueSpecificMaterials } from './QueueSpecificMaterials'
import { TargetSelect } from './targets'

/**
 * Trim a queue AMS mapping to its meaningful length, preserving the `-1` "auto" sentinel for
 * material-mode filaments (unlike `sanitizeTrayMapping`, which collapses `-1` to tray 0). Returns
 * undefined when nothing is explicitly slot-mapped, so a fully material/auto item carries no
 * explicit mapping and the dispatcher resolves every slot by material match.
 */
function sanitizeQueueMapping(mapping: number[]): number[] | undefined {
  let lastSet = -1
  for (let index = 0; index < mapping.length; index += 1) if ((mapping[index] ?? -1) >= 0) lastSet = index
  if (lastSet === -1) return undefined
  return mapping.slice(0, lastSet + 1).map((value) => (value == null || value < 0 ? -1 : value))
}

interface SelectedFile {
  id: string
  name: string
}

interface QueueItemDialogProps {
  open: boolean
  onClose: () => void
  /**
   * When provided, the dialog shows a "Back" action that returns to the step it was
   * opened from (e.g. the slice settings in the slice-to-queue flow), which stays
   * mounted underneath. Without it, only Cancel is offered.
   */
  onBack?: () => void
  /** Create with a known file (library menu); omit for the searchable Queue-tab add. */
  fixedFile?: SelectedFile
  /** Preselect this plate (e.g. an order item's plate). */
  defaultPlate?: number
  /** When queuing an order item, link the created item to its order print (fixes quantity to 1). */
  orderLink?: QueueOrderLink
  /** Edit an existing queued item. */
  item?: QueueItem
}

function decodeTarget(value: string): QueueTarget {
  if (value.startsWith('printer:')) return { kind: 'printer', printerId: value.slice('printer:'.length), model: null }
  if (value.startsWith('model:')) return { kind: 'model', printerId: null, model: value.slice('model:'.length) }
  return { kind: 'any', printerId: null, model: null }
}

function encodeTarget(target: QueueItem['target']): string {
  if (target.kind === 'printer' && target.printerId) return `printer:${target.printerId}`
  if (target.kind === 'model' && target.model) return `model:${target.model}`
  return 'any'
}

function toProjectFilament(filament: ThreeMfIndex['plates'][number]['filaments'][number]): ThreeMfProjectFilament {
  return {
    id: filament.id,
    filamentType: filament.filamentType,
    filamentName: filament.filamentName,
    color: filament.color,
    nozzleId: filament.nozzleId ?? null,
    chamberTemperature: filament.chamberTemperature ?? null
  }
}

export function QueueItemDialog({ open, onClose, onBack, fixedFile, defaultPlate, orderLink, item }: QueueItemDialogProps) {
  const isEdit = Boolean(item)
  const initialFile: SelectedFile | null = item
    ? (item.libraryFileId ? { id: item.libraryFileId, name: item.fileName } : null)
    : fixedFile ?? null

  // The file is always known up front (the Queue picker / library menu provide it,
  // or it comes from the item being edited), so there is no in-dialog file search.
  const selectedFile = initialFile
  const [plateIndex, setPlateIndex] = useState(item?.plateIndex ?? defaultPlate ?? 1)
  const [quantity, setQuantity] = useState(item?.quantity ?? 1)
  const [targetValue, setTargetValue] = useState(item ? encodeTarget(item.target) : 'any')
  const [options, setOptions] = useState<QueuePrintOptions>(item?.options ?? queuePrintOptionsSchema.parse({}))
  // Overrides default to null = "follow the file/printer"; set once the user edits.
  const [mappingOverride, setMappingOverride] = useState<number[] | null>(item?.amsMapping ?? null)
  const [materialsOverride, setMaterialsOverride] = useState<QueueRequiredFilament[] | null>(item?.requiredFilaments ?? null)
  /**
   * Per-object deselection (sliced plates with a real object list only). Persisted on
   * the queued item as `options.skipObjects` and passed through to dispatch, where the
   * server maps it to instance identify_ids for the start command (plus the mid-print
   * fallback). Plate-specific, so a plate change resets it.
   */
  const [deselectedObjectIds, setDeselectedObjectIds] = useState<number[]>(item?.options.skipObjects ?? [])

  const addItem = useAddQueueItem()
  const updateItem = useUpdateQueueItem()
  const target = decodeTarget(targetValue)

  const printersQuery = useQuery<{ printers: Printer[] }>({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal }),
    enabled: open
  })
  const printers = useMemo(() => printersQuery.data?.printers ?? [], [printersQuery.data])

  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const statuses = useMemo(() => statusQuery.data ?? {}, [statusQuery.data])

  const isThreeMf = selectedFile ? /\.3mf$/i.test(selectedFile.name) : false
  const resourceBasePath = selectedFile ? buildLibraryResourceBasePath(selectedFile.id, null) : null
  const platesQuery = useQuery<ThreeMfIndex>({
    queryKey: ['library-plates', selectedFile?.id ?? 'none'],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBasePath}/plates`, { signal }),
    enabled: open && Boolean(selectedFile) && isThreeMf,
    staleTime: 60_000
  })
  const plates = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data])
  const activePlate = useMemo(() => plates.find((plate) => plate.index === plateIndex) ?? plates[0], [plates, plateIndex])

  // A sliced single-plate output keeps its source plate number (e.g. only "Plate 2"
  // exists), so the default index of 1 would not exist in the file — snap to the first
  // real plate once they load, otherwise the create rejects with "Plate N does not exist".
  useEffect(() => {
    const first = plates[0]
    if (first && !plates.some((plate) => plate.index === plateIndex)) setPlateIndex(first.index)
  }, [plates, plateIndex])

  // Sliced gcode is machine-specific, so only offer printers/models the file is
  // compatible with (empty = no constraint, e.g. a plain .gcode).
  const compatibleModels = useMemo(
    () => item?.compatibleModels ?? platesQuery.data?.compatiblePrinterModels ?? [],
    [item, platesQuery.data]
  )
  const compatiblePrinters = useMemo(
    () => printers.filter((printer) => isPrinterModelCompatible(compatibleModels as PrinterModel[], printer.model as PrinterModel)),
    [printers, compatibleModels]
  )

  // The file's own required filaments on the active plate.
  const fileFilaments = useMemo<QueueRequiredFilament[]>(
    () => (activePlate?.filaments ?? []).map((filament) => ({ id: filament.id, filamentType: filament.filamentType, color: filament.color, filamentName: filament.filamentName })),
    [activePlate]
  )
  const projectFilaments = useMemo(() => (activePlate?.filaments ?? []).map(toProjectFilament), [activePlate])
  const usedIds = useMemo(() => new Set((activePlate?.filaments ?? []).map((filament) => filament.id)), [activePlate])
  const visibleFilaments = useMemo(() => visibleMappingFilaments(projectFilaments, usedIds, true), [projectFilaments, usedIds])
  const usedGramsById = useMemo(
    () => new Map((activePlate?.filaments ?? []).flatMap((filament) => (filament.usedGrams != null ? [[filament.id, filament.usedGrams] as const] : []))),
    [activePlate]
  )

  const effectiveMaterials = materialsOverride ?? fileFilaments

  const plateObjects = useMemo(() => activePlate?.objects ?? [], [activePlate])
  const showObjectSelection = plateHasSliceData(activePlate) && plateObjects.length >= 2
  const deselectedObjectIdSet = useMemo(() => new Set(deselectedObjectIds), [deselectedObjectIds])
  const toggleObjectSelected = (objectId: number, selected: boolean) => {
    setDeselectedObjectIds((current) => {
      if (selected) return current.filter((id) => id !== objectId)
      return current.includes(objectId) ? current : [...current, objectId]
    })
  }

  // Default AMS mapping for a specific-printer target (overridden once the user edits a slot).
  const computedMapping = useMemo(() => {
    if (target.kind !== 'printer' || !target.printerId) return []
    const status = statuses[target.printerId]
    if (!status) return []
    const required = visibleFilaments.map((filament) => ({ id: filament.id, filamentType: filament.filamentType, color: filament.color }))
    return evaluateQueueMatch(required, loadedSlotsFromStatus(status), { allowTypeOnlyMatch: false }).amsMapping
  }, [target.kind, target.printerId, statuses, visibleFilaments])
  const effectiveMapping = mappingOverride ?? computedMapping

  const changePlate = (next: number) => {
    setPlateIndex(next)
    // The new plate has its own filaments and objects; drop overrides so they re-seed from it.
    setMappingOverride(null)
    setMaterialsOverride(null)
    setDeselectedObjectIds([])
  }
  const changeTarget = (next: string) => {
    setTargetValue(next)
    setMappingOverride(null)
  }

  const targetPrinter = target.kind === 'printer' && target.printerId ? printers.find((printer) => printer.id === target.printerId) : undefined

  // Gate the Print settings to what the target actually supports, exactly like the Print
  // dialog: a specific printer uses its own (live) capabilities; "any"/model uses the union
  // over the file's compatible models. Null = no model info (plain gcode) → show the full set.
  const optionCapabilities = useMemo(() => {
    const entries: PrinterPrintStartOptions[] = []
    if (target.kind === 'printer' && targetPrinter) {
      const status = statuses[targetPrinter.id]
      entries.push(getPrinterPrintStartOptions(
        targetPrinter.model as PrinterModel,
        status ? { printOptions: status.printOptions, printStartOptions: status.printStartOptions } : null
      ))
    } else {
      const models = (target.kind === 'model' && target.model ? [target.model] : compatibleModels) as PrinterModel[]
      for (const model of models) entries.push(getPrinterPrintStartOptions(model, null))
    }
    if (entries.length === 0) return null
    const merged = mergePrintStartOptions(entries)
    return {
      timelapse: merged.timelapse.supported,
      bedLevel: merged.bedLevel.supported,
      bedLevelAuto: merged.bedLevel.autoSupported,
      vibrationCompensation: merged.vibrationCompensation.supported,
      flowCalibration: merged.flowCalibration.supported,
      flowCalibrationAuto: merged.flowCalibration.autoSupported,
      nozzleOffsetCalibration: merged.nozzleOffsetCalibration.supported
    }
  }, [target.kind, target.model, targetPrinter, statuses, compatibleModels])

  const submit = async () => {
    if (!selectedFile) return
    const isSpecific = target.kind === 'printer'
    // Preserve -1 (material-mode) entries so the dispatcher resolves those slots by material match.
    const amsMapping = isSpecific ? sanitizeQueueMapping(effectiveMapping) : undefined
    // Submit the actually-selected plate's index (the picker can resolve to a plate whose
    // number differs from the 1-based default, e.g. a single-plate sliced "Plate 2" output).
    const plate = activePlate?.index ?? plateIndex
    // Filter to the active plate's objects so a stale id can never be persisted.
    const skipObjects = showObjectSelection
      ? deselectedObjectIds.filter((id) => plateObjects.some((object) => object.id === id))
      : []
    const submittedOptions: QueuePrintOptions = {
      ...options,
      skipObjects: skipObjects.length > 0 ? skipObjects : undefined
    }
    try {
      if (isEdit && item) {
        await updateItem.mutateAsync({
          id: item.id,
          input: {
            plate,
            quantity,
            target,
            options: submittedOptions,
            amsMapping: isSpecific ? amsMapping ?? null : null,
            ...(materialsOverride ? { requiredFilaments: materialsOverride } : {})
          }
        })
        toast.success('Queued print updated')
      } else {
        await addItem.mutateAsync({
          libraryFileId: selectedFile.id,
          plate,
          // An order-linked item is one order print → always a single copy.
          quantity: orderLink ? 1 : quantity,
          target,
          options: submittedOptions,
          ...(isSpecific && amsMapping ? { amsMapping } : {}),
          ...(materialsOverride ? { requiredFilaments: materialsOverride } : {}),
          ...(orderLink ? { orderLink } : {}),
          label: null
        })
        toast.success(`Added "${selectedFile.name}" to the queue`)
      }
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the queued print')
    }
  }

  const busy = addItem.isPending || updateItem.isPending

  return (
    <Modal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 560, width: '100%' }}>
        <DialogTitle>{isEdit ? 'Edit queued print' : 'Add to queue'}</DialogTitle>
        <ScrollableDialogBody>
          <Stack spacing={2} sx={{ pt: 1 }}>
              <FormControl>
                <FormLabel>File</FormLabel>
                <Typography level="body-sm" noWrap>{selectedFile?.name ?? '—'}</Typography>
              </FormControl>

              {isThreeMf && plates.length > 0 ? (
                <DialogSection title="Plate">
                  <LibraryPlateCardPicker
                    fileId={selectedFile!.id}
                    resourceBasePath={resourceBasePath ?? undefined}
                    thumbnailVersion={undefined}
                    plates={plates}
                    value={plateIndex}
                    onChange={changePlate}
                    label={null}
                  />
                </DialogSection>
              ) : null}

              {showObjectSelection && (
                <PrintObjectsSection
                  objects={plateObjects}
                  deselectedIds={deselectedObjectIdSet}
                  onToggle={toggleObjectSelected}
                />
              )}

              <Stack direction="row" spacing={2}>
                {/* An order-linked item maps to one order print, so copies are fixed at 1. */}
                {!orderLink && (
                  <FormControl sx={{ width: 120 }}>
                    <FormLabel>Copies</FormLabel>
                    <Input
                      type="number"
                      slotProps={{ input: { min: 1, max: 999 } }}
                      value={quantity}
                      onChange={(event) => setQuantity(Math.min(999, Math.max(1, Number(event.target.value) || 1)))}
                    />
                  </FormControl>
                )}
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Target printer</FormLabel>
                  <TargetSelect printers={compatiblePrinters} value={targetValue} onChange={changeTarget} />
                </FormControl>
              </Stack>

              {fileFilaments.length > 0 ? (
                <DialogSection title="Materials">
                  {target.kind === 'printer' ? (
                    targetPrinter ? (
                      <QueueSpecificMaterials
                        printer={targetPrinter}
                        status={statuses[targetPrinter.id]}
                        filaments={visibleFilaments}
                        fileFilaments={fileFilaments}
                        usedGramsById={usedGramsById}
                        mapping={effectiveMapping}
                        materials={effectiveMaterials}
                        onMappingChange={setMappingOverride}
                        onMaterialsChange={setMaterialsOverride}
                      />
                    ) : (
                      <Typography level="body-xs" textColor="text.tertiary">Choose a connected printer to map its AMS slots.</Typography>
                    )
                  ) : (
                    <QueueMaterialEditor fileFilaments={fileFilaments} value={effectiveMaterials} usedGramsById={usedGramsById} onChange={setMaterialsOverride} />
                  )}
                </DialogSection>
              ) : null}

              <DialogSection title="Print settings">
                <PrintStartOptionsFields
                  timelapse={options.timelapse}
                  onTimelapseChange={(value) => setOptions({ ...options, timelapse: value })}
                  bedLevel={options.bedLevel}
                  onBedLevelChange={(value) => setOptions({ ...options, bedLevel: value })}
                  vibrationCompensation={options.vibrationCompensation}
                  onVibrationCompensationChange={(value) => setOptions({ ...options, vibrationCompensation: value })}
                  flowCalibration={options.flowCalibration}
                  onFlowCalibrationChange={(value) => setOptions({ ...options, flowCalibration: value })}
                  nozzleOffsetCalibration={options.nozzleOffsetCalibration}
                  onNozzleOffsetCalibrationChange={(value) => setOptions({ ...options, nozzleOffsetCalibration: value })}
                  capabilities={optionCapabilities}
                />
              </DialogSection>
          </Stack>
        </ScrollableDialogBody>
        <DialogActions sx={{ justifyContent: onBack ? 'space-between' : undefined }}>
          {onBack && (
            <Button
              variant="plain"
              color="neutral"
              startDecorator={<ArrowBackRoundedIcon />}
              onClick={onBack}
              disabled={busy}
            >
              Back
            </Button>
          )}
          <Stack direction="row" spacing={1}>
            <Button variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
            <Button variant="solid" loading={busy} disabled={!selectedFile} onClick={submit}>
              {isEdit ? 'Save' : 'Add to queue'}
            </Button>
          </Stack>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

