/**
 * Per-printer card dialogs extracted from `pages/PrintersView.tsx`: the
 * printer settings (air management + Bambu Studio-style print options),
 * calibration picker, skip-object first-layer map, attention assistant, and
 * paused-print filament recovery dialogs. Each is a controlled modal that
 * emits commands to its caller.
 */
import { useMemo, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, CircularProgress, Divider, FormControl, FormLabel, Link, ModalClose, ModalDialog, Option, Select, Sheet, Stack, Typography
} from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import AddIcon from '@mui/icons-material/Add'
import {
  getPrinterCalibrationCapabilities,
  getPrinterDisplayCapabilities,
  isPausedFilamentRunoutWarning,
  type PrinterActivePrintObjects,
  type PrinterAirductMode,
  type PrinterCommand,
  type PrinterModel,
  type PrinterSelectableAirductMode,
  type PrinterStatus
} from '@printstream/shared'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { DialogSection } from '../DialogSection'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { Printer3dRoundedIcon } from '../Printer3dRoundedIcon'
import {
  defaultPrintOptionSensitivity,
  formatDuctMode,
  formatHmsDisplayCode,
  hmsFallbackMessage,
  hmsSupportSearchUrl,
  printOptionSensitivityLabel,
  printOptionSensitivityOptions,
  printOptionSupportsSensitivity
} from '../../lib/printersViewHelpers'
import {
  AIR_MANAGEMENT_MODES,
  PRINTER_SETTINGS_DESCRIPTIONS,
  PRINTER_SETTINGS_LABELS,
  PRINTER_SETTINGS_SECTIONS
} from '../../lib/printerViewConstants'
import {
  type PrinterRecoveryFilamentSource,
  type PrinterRecoveryLoadCommand,
  type PrinterSettingsDialogCommand
} from '../../lib/printerViewTypes'

export function PrinterSettingsDialog({
  printerModel,
  printerName,
  ductMode,
  ductAvailableModes,
  settings,
  submitting,
  onClose,
  onSubmit
}: {
  printerModel: PrinterModel
  printerName: string
  ductMode: PrinterAirductMode | null
  ductAvailableModes: PrinterSelectableAirductMode[]
  settings: PrinterStatus['printOptions']
  submitting: boolean
  onClose: () => void
  onSubmit: (command: PrinterSettingsDialogCommand) => void
}) {
  const supportedSections = PRINTER_SETTINGS_SECTIONS
    .map((section) => ({
      ...section,
      options: section.options.filter((option) => settings[option].supported)
    }))
    .filter((section) => section.options.length > 0)
  const supportsAirManagement = getPrinterDisplayCapabilities(printerModel).airductMode
  const airManagementLocked = ductMode === 'laser'
  const availableAirManagementModes = ductAvailableModes.length > 0 ? ductAvailableModes : AIR_MANAGEMENT_MODES
  const selectedAirManagementMode: PrinterSelectableAirductMode = ductMode === 'heating' ? 'heating' : 'cooling'

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '96vw', sm: 720 }, maxWidth: '100%' }}>
        <ModalClose />
        <Typography level="h4">Printer settings for {printerName}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          These options come from the printer&apos;s live capability report. Unsupported settings stay hidden.
        </Typography>

        <ScrollableDialogBody>
          <Stack spacing={1.5}>
            {supportsAirManagement && (
              <Stack spacing={1}>
                <Typography level="title-sm">Air management</Typography>
                <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                  <Stack spacing={1.25}>
                    {airManagementLocked ? (
                      <>
                        <Typography level="body-sm">Current mode: {formatDuctMode('laser')}</Typography>
                        <Typography level="body-xs" color="warning">
                          Air management cannot be changed while the printer reports laser mode.
                        </Typography>
                      </>
                    ) : (
                      <FormControl size="sm" disabled={submitting || availableAirManagementModes.length === 0}>
                        <FormLabel>Mode</FormLabel>
                        <Select
                          value={selectedAirManagementMode}
                          onChange={(_event, value) => {
                            if (!value || value === selectedAirManagementMode) return
                            onSubmit({ type: 'setAirductMode', mode: value })
                          }}
                        >
                          {availableAirManagementModes.map((value) => (
                            <Option key={value} value={value}>{formatDuctMode(value)}</Option>
                          ))}
                        </Select>
                      </FormControl>
                    )}
                    <Typography level="body-xs" textColor="text.tertiary">
                      Supported modes come from the printer's live report when firmware exposes them.
                    </Typography>
                  </Stack>
                </Sheet>
              </Stack>
            )}
            {supportedSections.length === 0 && !supportsAirManagement ? (
              <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'md' }}>
                <Typography level="body-sm">This printer has not reported any configurable Bambu Studio-style settings yet.</Typography>
              </Sheet>
            ) : supportedSections.map((section) => (
              <Stack key={section.title} spacing={1}>
                <Typography level="title-sm">{section.title}</Typography>
                {section.options.map((optionKey) => {
                  const option = settings[optionKey]
                  const supportsSensitivity = printOptionSupportsSensitivity(optionKey)
                  const selectedSensitivity = ('sensitivity' in option ? option.sensitivity : null) ?? defaultPrintOptionSensitivity(optionKey)
                  return (
                    <Sheet key={optionKey} variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Checkbox
                            label={PRINTER_SETTINGS_LABELS[optionKey]}
                            checked={option.enabled ?? false}
                            disabled={submitting}
                            onChange={(event) => onSubmit({
                              type: 'setPrintOption',
                              option: optionKey,
                              enabled: event.target.checked,
                              ...(supportsSensitivity ? { sensitivity: selectedSensitivity } : {})
                            })}
                          />
                          <Typography level="body-xs" textColor="text.tertiary" sx={{ ml: 3.25, mt: 0.5 }}>
                            {PRINTER_SETTINGS_DESCRIPTIONS[optionKey]}
                          </Typography>
                        </Box>
                        {supportsSensitivity && (
                          <FormControl size="sm" sx={{ minWidth: { xs: '100%', sm: 180 } }}>
                            <FormLabel>Sensitivity</FormLabel>
                            <Select
                              value={selectedSensitivity}
                              disabled={submitting}
                              onChange={(_event, value) => {
                                if (!value) return
                                onSubmit({
                                  type: 'setPrintOption',
                                  option: optionKey,
                                  enabled: option.enabled ?? false,
                                  sensitivity: value
                                })
                              }}
                            >
                              {printOptionSensitivityOptions(optionKey).map((value) => (
                                <Option key={value} value={value}>{printOptionSensitivityLabel(value)}</Option>
                              ))}
                            </Select>
                          </FormControl>
                        )}
                      </Stack>
                    </Sheet>
                  )
                })}
              </Stack>
            ))}
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function CalibrationModal({
  capabilities,
  printerName,
  submitting,
  onClose,
  onSubmit
}: {
  capabilities: ReturnType<typeof getPrinterCalibrationCapabilities>
  printerName: string
  submitting: boolean
  onClose: () => void
  onSubmit: (command: Extract<PrinterCommand, { type: 'calibrate' }>) => void
}) {
  const [xcam, setXcam] = useState<boolean>(false)
  const [bedLeveling, setBedLeveling] = useState(capabilities.bedLeveling)
  const [vibration, setVibration] = useState(capabilities.vibration)
  const [motorNoise, setMotorNoise] = useState(false)
  const [nozzleOffset, setNozzleOffset] = useState(false)
  const [highTempHeatbed, setHighTempHeatbed] = useState(false)
  const [nozzleClumping, setNozzleClumping] = useState(false)
  const hasSelection = xcam || bedLeveling || vibration || motorNoise || nozzleOffset || highTempHeatbed || nozzleClumping

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: { xs: '94vw', sm: 420 } }}>
        <ModalClose />
        <Typography level="h4">Calibrate {printerName}</Typography>
        <Stack spacing={1.25} sx={{ mt: 1 }}>
          {capabilities.bedLeveling && (
            <Checkbox label="Auto bed leveling" checked={bedLeveling} onChange={(event) => setBedLeveling(event.target.checked)} />
          )}
          {capabilities.vibration && (
            <Checkbox label="Vibration compensation" checked={vibration} onChange={(event) => setVibration(event.target.checked)} />
          )}
          {capabilities.motorNoise && (
            <Checkbox label="Motor noise cancellation" checked={motorNoise} onChange={(event) => setMotorNoise(event.target.checked)} />
          )}
          {capabilities.nozzleOffset && (
            <Checkbox label="Nozzle offset calibration" checked={nozzleOffset} onChange={(event) => setNozzleOffset(event.target.checked)} />
          )}
          {capabilities.highTempHeatbed && (
            <Checkbox label="High-temperature bed leveling" checked={highTempHeatbed} onChange={(event) => setHighTempHeatbed(event.target.checked)} />
          )}
          {capabilities.xcam && (
            <Checkbox label="Micro Lidar calibration" checked={xcam} onChange={(event) => setXcam(event.target.checked)} />
          )}
          {capabilities.nozzleClumping && (
            <Checkbox label="Nozzle clumping detection" checked={nozzleClumping} onChange={(event) => setNozzleClumping(event.target.checked)} />
          )}
        </Stack>
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            startDecorator={<Printer3dRoundedIcon />}
            loading={submitting}
            disabled={!hasSelection}
            onClick={() => onSubmit({
              type: 'calibrate',
              xcam,
              bedLeveling,
              vibration,
              motorNoise,
              nozzleOffset,
              highTempHeatbed,
              nozzleClumping
            })}
          >
            Start
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}

export function SkipObjectsModal({
  printerName,
  objects,
  loading,
  unavailable,
  unavailableReason,
  unavailableMessage,
  submitting,
  onClose,
  onSkip
}: {
  printerName: string
  objects: PrinterActivePrintObjects['objects']
  loading: boolean
  unavailable: boolean
  unavailableReason: PrinterActivePrintObjects['unavailableReason']
  unavailableMessage: PrinterActivePrintObjects['unavailableMessage']
  submitting: boolean
  onClose: () => void
  onSkip: (objectIds: number[]) => void
}) {
  const [selectedObjectIds, setSelectedObjectIds] = useState<number[]>([])

  const selectedObjectIdSet = useMemo(() => new Set(selectedObjectIds), [selectedObjectIds])
  const previewObjects = useMemo(() => {
    return objects.filter((object) => object.previewPath && object.previewBounds)
  }, [objects])
  const objectLabels = useMemo(() => {
    const totals = new Map<string, number>()
    for (const object of objects) {
      const label = object.name.trim() || 'Unnamed object'
      totals.set(label, (totals.get(label) ?? 0) + 1)
    }

    const seen = new Map<string, number>()
    return new Map(objects.map((object) => {
      const label = object.name.trim() || 'Unnamed object'
      const total = totals.get(label) ?? 0
      if (total <= 1) return [object.id, label] as const

      const index = (seen.get(label) ?? 0) + 1
      seen.set(label, index)
      return [object.id, `${label} ${index}/${total}`] as const
    }))
  }, [objects])

  const previewViewBox = useMemo(() => {
    if (previewObjects.length === 0) return null
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const object of previewObjects) {
      const bounds = object.previewBounds
      if (!bounds) continue
      minX = Math.min(minX, bounds.minX)
      minY = Math.min(minY, bounds.minY)
      maxX = Math.max(maxX, bounds.maxX)
      maxY = Math.max(maxY, bounds.maxY)
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null
    }
    const padding = 4
    return {
      minX: minX - padding,
      minY: minY - padding,
      width: Math.max(1, maxX - minX + padding * 2),
      height: Math.max(1, maxY - minY + padding * 2),
      flipY: minY + maxY
    }
  }, [previewObjects])
  const previewAspectRatio = useMemo(
    () => previewViewBox ? previewViewBox.width / previewViewBox.height : 1,
    [previewViewBox]
  )
  const previewPanelHeight = useMemo(
    () => ({
      xs: previewAspectRatio < 0.8 ? 'min(42svh, 360px)' : 'min(38svh, 320px)',
      md: previewAspectRatio < 0.8 ? 'min(48dvh, 520px)' : 'min(56dvh, 560px)'
    }),
    [previewAspectRatio]
  )

  const allObjectIds = useMemo(() => objects.map((object) => object.id), [objects])
  const allSelected = objects.length > 0 && selectedObjectIds.length === objects.length
  const partiallySelected = selectedObjectIds.length > 0 && selectedObjectIds.length < objects.length

  const toggleObject = (objectId: number) => {
    setSelectedObjectIds((current) => {
      return current.includes(objectId)
        ? current.filter((value) => value !== objectId)
        : [...current, objectId]
    })
  }

  const toggleAllObjects = (checked: boolean) => {
    setSelectedObjectIds(checked ? allObjectIds : [])
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog
        sx={{
          width: { xs: '96vw', md: 920 },
          maxWidth: '100%'
          // Let the dialog size to its content and grow up to the viewport cap that
          // ScrollableModalDialog already enforces; the body scrolls once that's reached.
        }}
      >
        <ModalClose />
        <Typography level="h4">Skip object on {printerName}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.25 }}>
          Choose one or more objects from the current plate to cancel while the rest of the print continues.
        </Typography>

        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Box
            sx={{
              display: 'grid',
              gap: 1.25,
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 280px' },
              alignItems: 'stretch',
              minHeight: 0,
              '& > *': { minWidth: 0 }
            }}
          >
            <DialogSection title="Preview">
              <Box
                sx={{
                  minWidth: 0,
                  minHeight: { xs: 0, md: 'auto' },
                  height: previewPanelHeight,
                  borderRadius: 'xl',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1'
                }}
              >
                {loading ? (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <CircularProgress size="sm" />
                    <Typography level="body-sm">Loading first-layer object map…</Typography>
                  </Stack>
                ) : previewViewBox ? (
                  <Box
                    component="svg"
                    viewBox={`${previewViewBox.minX} ${previewViewBox.minY} ${previewViewBox.width} ${previewViewBox.height}`}
                    preserveAspectRatio="xMidYMid meet"
                    sx={{
                      width: '100%',
                      height: '100%',
                      maxWidth: '100%',
                      maxHeight: '100%',
                      display: 'block',
                      flex: 1
                    }}
                  >
                    <g transform={`translate(0 ${previewViewBox.flipY}) scale(1 -1)`}>
                      {previewObjects.map((object) => {
                        const selected = selectedObjectIdSet.has(object.id)
                        const label = objectLabels.get(object.id) ?? 'Unnamed object'
                        return (
                          <path
                            key={object.id}
                            d={object.previewPath ?? ''}
                            fill={selected ? 'var(--joy-palette-warning-300)' : 'rgba(255, 255, 255, 0.72)'}
                            fillRule="evenodd"
                            stroke="none"
                            style={{
                              cursor: submitting ? 'default' : 'pointer',
                              filter: selected ? 'drop-shadow(0 0 0.45rem rgba(255, 221, 63, 0.35))' : undefined,
                              transition: 'fill 120ms ease, filter 120ms ease'
                            }}
                            onClick={submitting ? undefined : () => toggleObject(object.id)}
                          >
                            <title>{label}</title>
                          </path>
                        )
                      })}
                    </g>
                  </Box>
                ) : (
                  <Typography level="body-sm" textColor="text.tertiary" sx={{ px: 2, textAlign: 'center' }}>
                    First-layer shape data is unavailable for this print, but the object list can still be used.
                  </Typography>
                )}
              </Box>
            </DialogSection>

            <DialogSection title="Objects">
              <Stack spacing={1.25} sx={{ minHeight: 0 }}>
                <Checkbox
                  label="Select all"
                  checked={allSelected}
                  indeterminate={partiallySelected}
                  disabled={loading || objects.length === 0 || submitting}
                  onChange={(event) => toggleAllObjects(event.target.checked)}
                />
                <Divider />
                <Box
                  sx={{
                    minHeight: 0,
                    // Let the full list render; the dialog body scrolls as one unit once the
                    // preview + list exceed the viewport cap, rather than a nested mini-scroller.
                    pr: 0.5
                  }}
                >
                  <Stack spacing={0.75}>
                    {!loading && unavailable && (
                      <Stack spacing={0.5}>
                        <Typography level="body-sm" textColor="text.tertiary">
                          This print did not expose skippable object metadata.
                        </Typography>
                        {unavailableReason === 'internalStorageUnsupported' && unavailableMessage ? (
                          <Typography level="body-xs" textColor="text.tertiary">
                            {unavailableMessage}
                          </Typography>
                        ) : (
                          <Typography level="body-xs" textColor="text.tertiary">
                            Some newer printer and firmware combinations only expose this data when the job is stored on printer-accessible external media.
                          </Typography>
                        )}
                      </Stack>
                    )}

                    {!loading && !unavailable && objects.map((object) => {
                      const label = objectLabels.get(object.id) ?? 'Unnamed object'
                      return (
                        <Checkbox
                          key={object.id}
                          label={label}
                          checked={selectedObjectIdSet.has(object.id)}
                          disabled={submitting}
                          onChange={() => toggleObject(object.id)}
                        />
                      )
                    })}
                  </Stack>
                </Box>
              </Stack>
            </DialogSection>
          </Box>
        </ScrollableDialogBody>

        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} spacing={1} sx={{ mt: 1.5, flexShrink: 0 }}>
          <Typography level="body-sm" textColor={selectedObjectIds.length > 0 ? 'success.500' : 'text.tertiary'}>
            {selectedObjectIds.length}/{objects.length} selected
          </Typography>

          <Stack direction="row" justifyContent="flex-end" spacing={1}>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={submitting}>Close</Button>
            <Button
              color="warning"
              disabled={loading || selectedObjectIds.length === 0 || submitting}
              onClick={() => onSkip(selectedObjectIds)}
            >
              Skip selected
            </Button>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function PrinterAssistantDialog({
  printerName,
  printerModel,
  printerSerial,
  status,
  canOpenLiveView,
  canLoadFilament,
  onClose,
  onOpenLiveView,
  onLoadFilament
}: {
  printerName: string
  printerModel: PrinterModel
  printerSerial: string
  status: PrinterStatus
  canOpenLiveView: boolean
  canLoadFilament: boolean
  onClose: () => void
  onOpenLiveView: () => void
  onLoadFilament: () => void
}) {
  const attentionEntries = status.hmsErrors.length > 0
    ? status.hmsErrors
    : status.deviceError ? [status.deviceError] : []

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: '100%', maxWidth: 560 }}>
        <ModalClose />
        <Typography level="h4">{printerName} assistant</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Review the printer warning and choose the next recovery step.
        </Typography>
        <ScrollableDialogBody>
          <Stack spacing={1.25}>
            {isPausedFilamentRunoutWarning(status) && (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                Follow the printer prompt to replace the empty filament, then resume once the AMS is ready.
              </Alert>
            )}
            {attentionEntries.map((entry) => (
              <Sheet key={`${entry.code}:${entry.message ?? ''}`} variant="soft" color="warning" sx={{ p: 1.25, borderRadius: 'sm' }}>
                <Stack spacing={0.5}>
                  <Link
                    href={hmsSupportSearchUrl(entry.code, entry.message, printerModel, printerSerial)}
                    target="_blank"
                    rel="noreferrer noopener"
                    underline="hover"
                    color="warning"
                    level="title-sm"
                    sx={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}
                  >
                    {entry.message ?? hmsFallbackMessage(entry.code)}
                  </Link>
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ fontFamily: 'monospace' }}>
                    {formatHmsDisplayCode(entry.code)}
                  </Typography>
                </Stack>
              </Sheet>
            ))}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
          {canOpenLiveView && (
            <Button variant="soft" color="neutral" startDecorator={<VisibilityRoundedIcon />} onClick={onOpenLiveView}>
              Live view
            </Button>
          )}
          {canLoadFilament && (
            <Button variant="soft" color="neutral" startDecorator={<AddIcon />} onClick={onLoadFilament}>
              Load filament
            </Button>
          )}
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function FilamentRecoveryDialog({
  printerName,
  sources,
  submitting,
  onClose,
  onLoad
}: {
  printerName: string
  sources: PrinterRecoveryFilamentSource[]
  submitting: boolean
  onClose: () => void
  onLoad: (command: PrinterRecoveryLoadCommand) => void
}) {
  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: '100%', maxWidth: 520 }}>
        <ModalClose />
        <Typography level="h4">Load filament</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Choose the source to load on {printerName}, then resume the paused print when the printer is ready.
        </Typography>
        <ScrollableDialogBody>
          <Stack spacing={1}>
            {sources.length === 0 ? (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                No configured AMS slot or external spool is ready to load right now.
              </Alert>
            ) : (
              sources.map((source) => (
                <Sheet key={source.key} variant="soft" sx={{ p: 1.25, borderRadius: 'sm' }}>
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography level="title-sm">{source.label}</Typography>
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ textWrap: 'pretty' }}>
                        {source.detail}
                      </Typography>
                    </Box>
                    <Button size="sm" variant="soft" color="neutral" disabled={submitting} onClick={() => onLoad(source.command)}>
                      Load
                    </Button>
                  </Stack>
                </Sheet>
              ))
            )}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
