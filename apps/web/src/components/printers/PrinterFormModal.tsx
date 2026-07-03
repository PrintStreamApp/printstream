import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, Checkbox, Chip, FormControl, FormHelperText, FormLabel, Input, LinearProgress, ListDivider, ModalDialog, Option, Select, Stack, Typography } from '@mui/joy'
import AddIcon from '@mui/icons-material/Add'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useMutation } from '@tanstack/react-query'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { StaticPluginSlot } from '../../plugin/StaticPluginSlot'
import { type BridgeSummary, type PrinterConnectionValidation, extractErrorMessage, formatNozzleDiameterLabel, getDetectedPrinterNozzleDiameters, mayRequireExternalStorageForActiveSkipObjects, isDirectPrintableFileName, resolvePrinterNozzleDiameters, type DiscoveredPrinter, type LibraryFile, type PrinterNozzleDiameterSelection, type Printer, type PrinterModel, type PrinterStatus } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { DialogSection } from '../../components/DialogSection'
import { buildPrinterConnectionValidationFeedback } from '../../lib/printerConnectionValidation'
import { useRuntimePolicy } from '../../lib/runtimePolicy'
import { uploadLibraryFileInChunks, type ChunkedLibraryUploadPhase } from '../../lib/chunkedLibraryUpload'
import { NOZZLE_DIAMETER_OPTIONS, COMMON_PLATE_TYPES, formatLocalUploadPhase, printerNozzles, formatNozzleHardwareSummary } from '../../lib/printersViewHelpers'
import { DUAL_NOZZLE_PRINTER_MODELS, PUBLIC_DEMO_PRINTER_MUTATION_NOTICE, DEMO_TEMP_UPLOAD_MAX_BYTES } from '../../lib/printerViewConstants'

/**
 * Printer add/edit form modal and its supporting types/constants.
 * Includes LocalFilePrintGate, the hidden-file-input launcher used by
 * the printer card's "Print from local file" action.
 */

export interface PrinterFormValues {
  name: string
  host: string
  serial: string
  accessCode: string
  model: PrinterModel
  bridgeId: string
  currentPlateType: string | null
  currentNozzleDiameters: PrinterNozzleDiameterSelection[]
}

interface PrinterFormModalProps {
  mode: 'add' | 'edit'
  demoMode?: boolean
  submitting: boolean
  deleting?: boolean
  error: string | null
  initialValues?: PrinterFormValues
  status?: PrinterStatus
  bridges?: BridgeSummary[]
  /** Discovered LAN printers, used in `add` mode to pre-fill the form. */
  discovered?: DiscoveredPrinter[]
  onCancel: () => void
  onSubmit: (input: PrinterFormValues) => void
  onDelete?: () => void
}

const PRINTER_MODEL_GROUPS: Array<{ label: string; models: PrinterModel[] }> = [
  { label: 'A-series', models: ['A1', 'A1mini', 'A2L'] },
  { label: 'P-series', models: ['P1P', 'P1S', 'P2S'] },
  { label: 'H-series', models: ['H2C', 'H2D', 'H2DPRO', 'H2S'] },
  { label: 'X-series', models: ['X1', 'X1C', 'X1E', 'X2D'] }
]
const OTHER_PRINTER_MODELS: PrinterModel[] = ['unknown']

/**
 * "Print from local file" launcher for a specific printer. Mounts a
 * hidden file input that fires immediately on mount, uploads the picked
 * file as a hidden bridge-backed library row, and hands the resulting
 * `LibraryFile` row back to the caller so it can open the regular
 * `PrintModal`. Cancellation (the native picker's Cancel) closes the
 * gate without uploading.
 */

export function LocalFilePrintGate({
  demoMode = false,
  printer,
  onUploaded,
  onCancel
}: {
  demoMode?: boolean
  /** The destination printer determines which bridge stores the file. */
  printer: Printer
  onUploaded: (file: LibraryFile) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ phase: ChunkedLibraryUploadPhase; uploadedBytes: number; totalBytes: number } | null>(null)
  // Use a ref (not state) so React 18 strict-mode double-mount in dev
  // does not re-fire the click after the user has already picked a file.
  const openedRef = useRef(false)

  useEffect(() => {
    if (openedRef.current) return
    openedRef.current = true
    inputRef.current?.click()
  }, [demoMode, onCancel])

  const handleFile = async (file: File) => {
    setUploading(true)
    try {
      if (!printer.bridgeId) {
        throw new Error('Assign this printer to a bridge before printing a local file')
      }
      setUploadProgress({ phase: 'uploading-to-server', uploadedBytes: 0, totalBytes: file.size })
      const body = await uploadLibraryFileInChunks(file, {
        hidden: true,
        bridgeId: printer.bridgeId,
        onProgress: setUploadProgress
      })
      onUploaded(body.file)
    } catch (error) {
      toast.error((error as Error).message)
      onCancel()
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".gcode,.gcode.3mf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) {
            onCancel()
            return
          }
          if (!isDirectPrintableFileName(file.name)) {
            toast.error('Only .gcode or .gcode.3mf files can be printed directly')
            onCancel()
            return
          }
          if (demoMode && file.size > DEMO_TEMP_UPLOAD_MAX_BYTES) {
            toast.error('Demo uploads are limited to 15 MB.')
            onCancel()
            return
          }
          void handleFile(file)
        }}
      />
      {uploading && (
        <Modal open onClose={() => undefined}>
          <ModalDialog sx={{ maxWidth: 360 }}>
            <Typography level="title-md">Uploading to {printer.name}</Typography>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
              {uploadProgress ? formatLocalUploadPhase(uploadProgress.phase) : 'Preparing upload'}
            </Typography>
            <LinearProgress
              determinate={uploadProgress != null}
              value={uploadProgress ? (uploadProgress.uploadedBytes / Math.max(uploadProgress.totalBytes, 1)) * 100 : undefined}
              sx={{
                mt: 1,
                '--LinearProgress-thickness': '8px',
                '&::before': {
                  left: '2px',
                  inlineSize: 'max(calc(var(--LinearProgress-percent) * 1% - 4px), 0px)'
                }
              }}
            />
            {uploadProgress && (
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
                {Math.floor((uploadProgress.uploadedBytes / Math.max(uploadProgress.totalBytes, 1)) * 100)}%
              </Typography>
            )}
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
              The file will not be saved to the library.
            </Typography>
          </ModalDialog>
        </Modal>
      )}
    </>
  )
}

export function PrinterFormModal({
  mode,
  demoMode = false,
  submitting,
  deleting = false,
  error,
  initialValues,
  status,
  bridges = [],
  discovered = [],
  onCancel,
  onSubmit,
  onDelete
}: PrinterFormModalProps) {
  const [name, setName] = useState(initialValues?.name ?? '')
  const [host, setHost] = useState(initialValues?.host ?? '')
  const [serial, setSerial] = useState(initialValues?.serial ?? '')
  const [accessCode, setAccessCode] = useState(initialValues?.accessCode ?? '')
  const [model, setModel] = useState<PrinterModel>(initialValues?.model ?? 'P1S')
  const [bridgeId, setBridgeId] = useState<string>(initialValues?.bridgeId ?? bridges[0]?.id ?? '')
  const [currentPlateType, setCurrentPlateType] = useState(initialValues?.currentPlateType ?? null)
  const [currentNozzleDiameters, setCurrentNozzleDiameters] = useState<PrinterNozzleDiameterSelection[]>(initialValues?.currentNozzleDiameters ?? [])
  const [autoDetectNozzleHardware, setAutoDetectNozzleHardware] = useState(mode === 'add' && (initialValues?.currentNozzleDiameters.length ?? 0) === 0)
  const [connectionValidation, setConnectionValidation] = useState<PrinterConnectionValidation | null>(null)
  const [connectionValidationError, setConnectionValidationError] = useState<string | null>(null)
  // Managed-bridge installs own a single bundled bridge, so picking a
  // "connection location" is meaningless — auto-select it and hide the control.
  // Fall back to the picker if more than one bridge somehow exists.
  const { managedBridge } = useRuntimePolicy()
  const hideBridgePicker = managedBridge && bridges.length === 1

  const validateConnection = useMutation({
    mutationFn: (input: { host: string; serial: string; accessCode: string; bridgeId: string }) =>
      apiFetch<PrinterConnectionValidation>('/api/printers/validate', {
        method: 'POST',
        body: input
      }),
    onError: (mutationError) => {
      setConnectionValidation(null)
      setConnectionValidationError(extractErrorMessage(mutationError))
    }
  })

  const title = mode === 'add' ? 'Add printer' : 'Edit printer'
  const submitLabel = mode === 'add' ? 'Add' : 'Save'
  const connectionValidationFeedback = buildPrinterConnectionValidationFeedback(connectionValidation)
  const canTestConnection = Boolean(host.trim() && serial.trim() && accessCode.trim() && bridgeId) && bridges.length > 0
  const runConnectionTest = () => {
    setConnectionValidationError(null)
    setConnectionValidation(null)
    validateConnection.mutate(
      { host: host.trim(), serial: serial.trim().toUpperCase(), accessCode: accessCode.trim(), bridgeId },
      { onSuccess: (result) => setConnectionValidation(result) }
    )
  }
  const submitPending = submitting || validateConnection.isPending
  const isDualNozzleModel = DUAL_NOZZLE_PRINTER_MODELS.includes(model)
  const editableExtruderIds = isDualNozzleModel ? [0, 1] : [0]
  const detectedNozzleDiameters = getDetectedPrinterNozzleDiameters(status)
  const detectedNozzleDiameterMap = new Map(detectedNozzleDiameters.map((entry) => [entry.extruderId, entry.diameter]))
  const detectedNozzleMap = new Map(printerNozzles(status).map((entry) => [entry.extruderId, entry]))
  const sharedDetectedNozzle = detectedNozzleMap.get(0) ?? detectedNozzleMap.get(1) ?? null
  const sharedDetectedNozzleDiameter = sharedDetectedNozzle?.diameter ?? null
  const sharedSelectedNozzleDiameter = sharedDetectedNozzleDiameter
    ?? currentNozzleDiameters.find((entry) => entry.extruderId === 0)?.diameter
    ?? currentNozzleDiameters[0]?.diameter
    ?? null
  const sharedDetectedNozzleSummary = sharedDetectedNozzle ? formatNozzleHardwareSummary(sharedDetectedNozzle) : null
  const discoveredPrinterGroups = useMemo(() => {
    const bridgeNamesById = new Map(bridges.map((bridge) => [bridge.id, bridge.name] as const))
    const groups: Array<{ key: string; label: string; entries: DiscoveredPrinter[] }> = []
    const groupsByKey = new Map<string, { key: string; label: string; entries: DiscoveredPrinter[] }>()

    for (const entry of discovered) {
      const key = entry.bridgeId ?? '__unknown__'
      const existing = groupsByKey.get(key)
      if (existing) {
        existing.entries.push(entry)
        continue
      }

      const nextGroup = {
        key,
        label: entry.bridgeId ? (bridgeNamesById.get(entry.bridgeId) ?? 'Unknown bridge') : 'Unknown bridge',
        entries: [entry]
      }
      groupsByKey.set(key, nextGroup)
      groups.push(nextGroup)
    }

    return groups
  }, [bridges, discovered])

  useEffect(() => {
    if (!bridgeId && bridges[0]?.id) {
      setBridgeId(bridges[0].id)
    }
  }, [bridgeId, bridges])

  const updateNozzleDiameter = (extruderId: number, diameter: string | null) => {
    setCurrentNozzleDiameters((current) => {
      const next = [...current]
      const index = next.findIndex((entry) => entry.extruderId === extruderId)
      const updated = { extruderId, diameter }
      if (index >= 0) next[index] = updated
      else next.push(updated)
      return next.sort((left, right) => left.extruderId - right.extruderId)
    })
  }

  const updateSharedNozzleDiameter = (diameter: string | null) => {
    setCurrentNozzleDiameters(editableExtruderIds.map((extruderId) => ({ extruderId, diameter })))
  }

  const clearConnectionValidation = () => {
    if (mode !== 'add') return
    setConnectionValidation(null)
    setConnectionValidationError(null)
  }

  const applyDiscovered = (entry: DiscoveredPrinter) => {
    clearConnectionValidation()
    setName(entry.name ?? `Bambu ${entry.serial.slice(-6)}`)
    setHost(entry.host)
    setSerial(entry.serial)
    setModel(entry.model)
    setBridgeId(entry.bridgeId ?? '')
  }

  const handleSubmit = async () => {
    const trimmedHost = host.trim()
    const trimmedSerial = serial.trim().toUpperCase()
    const trimmedAccessCode = accessCode.trim()
    const resolvedNozzleDiameters = mode === 'add' && autoDetectNozzleHardware
      ? []
      : resolvePrinterNozzleDiameters(status, currentNozzleDiameters)
    const normalizedNozzleDiameters = isDualNozzleModel
      ? (() => {
          const sharedDiameter = resolvedNozzleDiameters.find((entry) => entry.extruderId === 0)?.diameter
            ?? resolvedNozzleDiameters[0]?.diameter
            ?? null
          return sharedDiameter == null
            ? []
            : editableExtruderIds.map((extruderId) => ({ extruderId, diameter: sharedDiameter }))
        })()
      : resolvedNozzleDiameters
    if (!bridgeId) {
      toast.error('Choose a connected bridge before saving this printer')
      return
    }

    if (mode === 'add') {
      setConnectionValidationError(null)
      try {
        const validation = await validateConnection.mutateAsync({
          host: trimmedHost,
          serial: trimmedSerial,
          accessCode: trimmedAccessCode,
          bridgeId
        })
        setConnectionValidation(validation)
        if (!validation.ok) {
          return
        }
      } catch {
        return
      }
    }

    const input: PrinterFormValues = {
      name,
      host: trimmedHost,
      serial: trimmedSerial,
      accessCode: trimmedAccessCode,
      model,
      bridgeId,
      currentPlateType,
      currentNozzleDiameters: normalizedNozzleDiameters
    }

    onSubmit(input)
  }

  const handleFormSubmit = (event: React.FormEvent<HTMLDivElement>) => {
    event.preventDefault()
    void handleSubmit()
  }

  return (
    <Modal open onClose={onCancel}>
      <ScrollableModalDialog
        component="form"
        onSubmit={handleFormSubmit}
        sx={{ width: { xs: '96vw', sm: 640 }, maxWidth: '100%' }}
      >
        <Typography level="h4">{title}</Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Stack spacing={2}>
            {/* Deployment-specific notices about adding a printer (e.g. the cloud's
                per-printer billing consent); renders nothing when no plugin fills it. */}
            {mode === 'add' && <StaticPluginSlot name="printers.addDialog.notice" />}
            {mode === 'add' && discovered.length > 0 && (
              <DialogSection
                title="Discovery"
                description="Found on your network. Choose a printer to fill the form, then enter its LAN access code from the printer screen."
              >
                <Stack spacing={1}>
                  {discoveredPrinterGroups.map((group) => (
                    <Stack key={group.key} spacing={0.5}>
                      <Typography
                        level="body-xs"
                        textColor="text.tertiary"
                        sx={{ px: 0.25, textTransform: 'uppercase', letterSpacing: '0.08em' }}
                      >
                        {group.label}
                      </Typography>
                      <Stack spacing={0.5}>
                        {group.entries.map((entry) => (
                          <Button
                            key={entry.serial}
                            variant="outlined"
                            color="neutral"
                            size="sm"
                            onClick={() => applyDiscovered(entry)}
                            sx={{ justifyContent: 'flex-start', textAlign: 'left' }}
                          >
                            <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
                              <Typography level="body-sm" sx={{ fontWeight: 'md', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {entry.name ?? `Bambu ${entry.serial.slice(-6)}`}
                              </Typography>
                              <Chip size="sm" variant="soft">{entry.model}</Chip>
                              <Typography level="body-xs" sx={{ opacity: 0.7 }}>{entry.host}</Typography>
                            </Stack>
                          </Button>
                        ))}
                      </Stack>
                    </Stack>
                  ))}
                </Stack>
              </DialogSection>
            )}
            {demoMode ? (
              <Alert color="neutral" variant="outlined" startDecorator={<InfoOutlinedIcon />}>
                <Typography level="body-sm">
                  {PUBLIC_DEMO_PRINTER_MUTATION_NOTICE}
                </Typography>
              </Alert>
            ) : null}
            {!demoMode && bridges.length === 0 ? (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                <Typography level="body-sm">
                  Connect a bridge first. Printers can only be added through a bridge.
                </Typography>
              </Alert>
            ) : null}

            <DialogSection title="Printer">
              <Stack spacing={1.25}>
                <FormControl>
                  <FormLabel>Name</FormLabel>
                  <Input value={name} onChange={(event) => setName(event.target.value)} />
                </FormControl>
                <FormControl>
                  <FormLabel>Model</FormLabel>
                  <Select value={model} onChange={(_event, value) => value && setModel(value)}>
                    {PRINTER_MODEL_GROUPS.flatMap((group, groupIndex) => {
                      const nodes = [
                        <Option key={`group-${group.label}`} value={group.models[0]} disabled sx={{ fontWeight: 'lg', opacity: 1 }}>
                          {group.label}
                        </Option>,
                        ...group.models.map((entry) => (
                          <Option key={entry} value={entry}>{entry}</Option>
                        ))
                      ]
                      if (groupIndex < PRINTER_MODEL_GROUPS.length - 1 || OTHER_PRINTER_MODELS.length > 0) {
                        nodes.push(<ListDivider key={`divider-${group.label}`} inset="gutter" />)
                      }
                      return nodes
                    })}
                    {OTHER_PRINTER_MODELS.length > 0 && (
                      <>
                        <Option value={OTHER_PRINTER_MODELS[0]} disabled sx={{ fontWeight: 'lg', opacity: 1 }}>
                          Other
                        </Option>
                        {OTHER_PRINTER_MODELS.map((entry) => (
                          <Option key={entry} value={entry}>{entry}</Option>
                        ))}
                      </>
                    )}
                  </Select>
                </FormControl>
              </Stack>
            </DialogSection>

            <DialogSection
              title="Connection"
              description="Enter the printer address, serial, LAN access code, and the bridge that can reach it on the local network."
            >
              <Stack spacing={1.25}>
                <FormControl>
                  <FormLabel>IP / hostname</FormLabel>
                  <Input value={host} onChange={(event) => {
                    clearConnectionValidation()
                    setHost(event.target.value)
                  }} />
                </FormControl>
                <FormControl>
                  <FormLabel>Serial</FormLabel>
                  <Input value={serial} onChange={(event) => {
                    clearConnectionValidation()
                    setSerial(event.target.value)
                  }} />
                </FormControl>
                <FormControl>
                  <FormLabel>LAN access code</FormLabel>
                  <Input
                    value={accessCode}
                    placeholder={mode === 'edit' ? 'Leave blank to keep the current code' : undefined}
                    onChange={(event) => {
                      clearConnectionValidation()
                      setAccessCode(event.target.value)
                    }}
                  />
                  {mode === 'edit' ? (
                    <FormHelperText>The stored access code is hidden. Enter a new one only to change it.</FormHelperText>
                  ) : null}
                </FormControl>
                {mayRequireExternalStorageForActiveSkipObjects(model) ? (
                  <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                    <Typography level="body-sm">
                      For H2D-, H2S-, and P2S-class printers, active Skip Objects works best when Bambu Studio stores sent files on external storage. Internal-only active jobs may not expose object metadata yet.
                    </Typography>
                  </Alert>
                ) : null}
                {!hideBridgePicker && (
                  <FormControl required>
                    <FormLabel>Connection location</FormLabel>
                    <Select
                      value={bridgeId || null}
                      onChange={(_event, value) => {
                        clearConnectionValidation()
                        setBridgeId(value ?? '')
                      }}
                      placeholder={bridges.length > 0 ? 'Select a bridge' : 'No connected bridges available'}
                    >
                      {bridges.map((bridge) => (
                        <Option key={bridge.id} value={bridge.id}>{bridge.name}</Option>
                      ))}
                    </Select>
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Choose the bridge that can reach this printer on the local network.
                    </Typography>
                  </FormControl>
                )}
                <Box>
                  <Button
                    type="button"
                    variant="outlined"
                    color="neutral"
                    loading={validateConnection.isPending}
                    disabled={demoMode || !canTestConnection}
                    onClick={runConnectionTest}
                  >
                    Test connection
                  </Button>
                </Box>
                {connectionValidationFeedback && (
                  <Alert color={connectionValidationFeedback.color} variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                    <Stack spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">
                        {connectionValidationFeedback.color === 'danger' ? 'Connection check failed' : 'Connection needs attention'}
                      </Typography>
                      {connectionValidationFeedback.messages.map((message) => (
                        <Typography key={message} level="body-sm">{message}</Typography>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {connectionValidation?.ok && (
                  <Alert color="success" variant="soft" startDecorator={<CheckCircleRoundedIcon />}>
                    <Typography level="body-sm">
                      Connection successful — the printer is reachable in LAN mode{connectionValidation.developerModeEnabled ? ' with developer mode enabled' : ''}.
                    </Typography>
                  </Alert>
                )}
                {connectionValidationError && <Typography color="danger" level="body-sm">{connectionValidationError}</Typography>}
              </Stack>
            </DialogSection>

            <DialogSection
              title="Installed hardware"
              description="Saved hardware settings are used for compatibility checks. Live nozzle details take over automatically when the printer reports them."
            >
              <Stack spacing={1.25} sx={{ minWidth: 0 }}>
                {mode === 'add' && (
                  <Stack spacing={0.75}>
                    <Stack direction="row" spacing={1} alignItems="flex-start">
                      <Checkbox
                        checked={autoDetectNozzleHardware}
                        onChange={(event) => setAutoDetectNozzleHardware(event.target.checked)}
                        sx={{ mt: 0.125 }}
                      />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography level="body-sm">Use detected nozzle hardware when available</Typography>
                        <Typography level="body-xs" textColor="text.tertiary">
                          Recommended. PrintStream will use the printer's live nozzle details when they are available, instead of making you choose them here first.
                        </Typography>
                      </Box>
                    </Stack>
                  </Stack>
                )}
                {detectedNozzleDiameters.length > 0 && (
                  <Typography level="body-xs" textColor="primary.softColor">
                    This printer is currently reporting installed nozzle details live. Those detected values will be used for print checks and saved as the fallback when you save.
                  </Typography>
                )}
                <FormControl>
                  <FormLabel>Current plate type (optional)</FormLabel>
                  <Select
                    value={currentPlateType}
                    placeholder="Leave unset"
                    onChange={(_event, value) => setCurrentPlateType(value && value !== '__unset__' ? value : null)}
                  >
                    <Option value="__unset__">Clear selection</Option>
                    {COMMON_PLATE_TYPES.map((entry) => (
                      <Option key={entry} value={entry}>{entry}</Option>
                    ))}
                  </Select>
                  <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                    Leave this unset if you do not know the installed plate yet. You can save the printer now and set it later.
                  </Typography>
                </FormControl>
                {isDualNozzleModel ? (
                  <FormControl>
                    <FormLabel>Nozzle size</FormLabel>
                    <Select
                      value={sharedSelectedNozzleDiameter ?? '__unset__'}
                      disabled={autoDetectNozzleHardware || sharedDetectedNozzleDiameter != null}
                      onChange={(_event, value) => updateSharedNozzleDiameter(value && value !== '__unset__' ? value : null)}
                    >
                      <Option value="__unset__">Not set</Option>
                      {NOZZLE_DIAMETER_OPTIONS.map((entry) => (
                        <Option key={`shared-${entry}`} value={entry}>{formatNozzleDiameterLabel(entry) ?? entry}</Option>
                      ))}
                    </Select>
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Applies to both nozzles. Bambu currently supports one installed nozzle size per dual-nozzle printer.
                    </Typography>
                    {sharedDetectedNozzleSummary && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                        Detected live: {sharedDetectedNozzleSummary}
                      </Typography>
                    )}
                  </FormControl>
                ) : editableExtruderIds.map((extruderId) => {
                  const detectedNozzle = detectedNozzleMap.get(extruderId)
                  const selectedDiameter = detectedNozzleDiameterMap.get(extruderId)
                    ?? currentNozzleDiameters.find((entry) => entry.extruderId === extruderId)?.diameter
                    ?? null
                  const hardwareSummary = detectedNozzle ? formatNozzleHardwareSummary(detectedNozzle) : null
                  return (
                    <FormControl key={extruderId}>
                      <FormLabel>Nozzle size</FormLabel>
                      <Select
                        value={selectedDiameter ?? '__unset__'}
                        disabled={autoDetectNozzleHardware || detectedNozzleDiameterMap.has(extruderId)}
                        onChange={(_event, value) => updateNozzleDiameter(extruderId, value && value !== '__unset__' ? value : null)}
                      >
                        <Option value="__unset__">Not set</Option>
                        {NOZZLE_DIAMETER_OPTIONS.map((entry) => (
                          <Option key={`${extruderId}-${entry}`} value={entry}>{formatNozzleDiameterLabel(entry) ?? entry}</Option>
                        ))}
                      </Select>
                      {hardwareSummary && (
                        <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                          Detected live: {hardwareSummary}
                        </Typography>
                      )}
                    </FormControl>
                  )
                })}
              </Stack>
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>
        {error && <Typography color="danger" level="body-sm">{error}</Typography>}
        <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            {mode === 'edit' && onDelete && (
              <Button type="button" variant="soft" color="danger" loading={deleting} disabled={submitPending} startDecorator={<DeleteRoundedIcon />} onClick={onDelete}>
                Remove
              </Button>
            )}
          </Box>
          <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center" sx={{ ml: 'auto' }}>
            <Button type="button" variant="plain" onClick={onCancel} disabled={submitPending}>Cancel</Button>
            <Button
              type="submit"
              loading={submitPending}
              disabled={demoMode || bridges.length === 0 || deleting}
              startDecorator={mode === 'add' ? <AddIcon /> : <SaveRoundedIcon />}
            >
              {submitLabel}
            </Button>
          </Stack>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
