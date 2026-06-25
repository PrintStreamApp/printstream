/**
 * External spool edit modal extracted from `pages/PrintersView.tsx`. Edits the
 * manual external spool (Bambu preset/color/type), supports reset, and exposes
 * load/unload filament actions, persisting through the printer command
 * endpoint.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  Autocomplete, AutocompleteOption, Button, ButtonGroup, FormControl, FormLabel, Input, ListItemContent, ModalDialog, Option, Select, Stack, Typography
} from '@mui/joy'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import { useMutation } from '@tanstack/react-query'
import {
  getExternalSpoolLoadAvailability,
  getExternalSpoolUnloadAvailability,
  type ExternalSpool,
  type PrinterStatus
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'
import { DialogSection } from '../DialogSection'
import { PluginSlot } from '../../plugin/PluginSlot'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { ColorSwatchPicker } from '../ColorSwatchPicker'
import { FilamentChangeProgressPanel } from './FilamentChangeProgressPanel'
import { bambuMaterialFromPresetName, bambuMaterialFromType } from '../../data/bambuColors'
import { BAMBU_FILAMENT_PRESETS, BAMBU_FILAMENT_PRESET_GROUPS, FILAMENT_PRESETS, filamentTypeDefaults } from '../../data/filamentSetupCatalog'
import { COMMON_FILAMENT_COLOR_SWATCHES, resolveFilamentColorSwatches } from '../../lib/filamentColor'
import { externalSpoolLabel, normalizeHex } from '../../lib/printersViewHelpers'
import { usePendingFilamentActionLabel, withDisabledActionReason } from './printerActionHelpers'

export function ExternalSpoolEditModal({
  printerId,
  status,
  spool,
  spoolCount,
  defaultNozzleTemp,
  onClose
}: {
  printerId: string
  status: PrinterStatus | undefined
  spool: ExternalSpool
  spoolCount: number
  defaultNozzleTemp: number
  onClose: () => void
}) {
  const label = externalSpoolLabel(spool.amsId, spoolCount)
  const initialBambuPreset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === spool.trayInfoIdx)
  const [type, setType] = useState<string>(spool.filamentType ?? initialBambuPreset?.type ?? 'PLA')
  const [color, setColor] = useState<string>(spool.color ?? '#000000')
  const [trayInfoIdx, setTrayInfoIdx] = useState<string>(spool.trayInfoIdx ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pendingFilamentActionLabel, setPendingFilamentActionLabel] = usePendingFilamentActionLabel(status)

  const tempsForCurrentType = () => {
    const fromBambu = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === trayInfoIdx)
    const preset = (fromBambu?.tempMin != null && fromBambu?.tempMax != null)
      ? { tempMin: fromBambu.tempMin, tempMax: fromBambu.tempMax }
      : filamentTypeDefaults(type)
    return { tempMin: preset?.tempMin ?? 190, tempMax: preset?.tempMax ?? 230 }
  }

  const send = useMutation({
    mutationFn: () => {
      const trayColor = color.replace('#', '').padEnd(8, 'F').slice(0, 8).toUpperCase()
      const { tempMin, tempMax } = tempsForCurrentType()
      return apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'setExternalSpool',
          amsId: spool.amsId,
          trayInfoIdx,
          trayColor,
          trayType: type,
          nozzleTempMin: tempMin,
          nozzleTempMax: tempMax
        }
      })
    },
    onSuccess: () => onClose(),
    onError: (err: Error) => setError(err.message)
  })

  const resetSpool = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: { type: 'resetExternalSpool', amsId: spool.amsId }
      }),
    onSuccess: () => {
      toast.success('External spool reset')
      onClose()
    },
    onError: (err: Error) => setError(err.message)
  })

  const loadSpool = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'loadExternalSpool',
          amsId: spool.amsId,
          extruderId: spool.nozzleId ?? undefined,
          nozzleTemp: defaultNozzleTemp
        }
      }),
    onSuccess: () => {
      setError(null)
      setPendingFilamentActionLabel('Loading filament')
      toast.success('External spool load requested')
    },
    onError: (err: Error) => setError(err.message)
  })

  const unloadSpool = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'unloadExternalSpool',
          amsId: spool.amsId,
          extruderId: spool.nozzleId ?? undefined,
          nozzleTemp: defaultNozzleTemp
        }
      }),
    onSuccess: () => {
      setError(null)
      setPendingFilamentActionLabel('Unloading filament')
      toast.success('External spool unload requested')
    },
    onError: (err: Error) => setError(err.message)
  })

  const applyPreset = (next: string) => {
    setType(next)
  }

  const applyBambuPreset = (next: string) => {
    setTrayInfoIdx(next)
    const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === next)
    if (!preset) return
    setType(preset.type)
  }

  // Lets the filament-manager plugin's "Pick from library" populate the form.
  const applyFilamentFromLibrary = useCallback((values: { filamentType?: string | null; colorHex?: string | null; trayInfoIdx?: string | null }) => {
    if (typeof values.trayInfoIdx === 'string') setTrayInfoIdx(values.trayInfoIdx)
    if (values.filamentType) setType(values.filamentType)
    if (values.colorHex) setColor(values.colorHex)
  }, [])

  const currentCustomPresetId = trayInfoIdx && !BAMBU_FILAMENT_PRESETS.some((preset) => preset.id === trayInfoIdx)
    ? trayInfoIdx
    : null

  type PresetOption = { id: string; label: string; brand: string }
  const presetOptions = useMemo<PresetOption[]>(() => [
    { id: '', label: 'Custom / no Bambu preset', brand: 'Custom' },
    ...(currentCustomPresetId
      ? [{ id: currentCustomPresetId, label: 'Current custom preset', brand: 'Custom' } as PresetOption]
      : []),
    ...BAMBU_FILAMENT_PRESET_GROUPS.flatMap((group) =>
      group.presets.map((preset) => ({ id: preset.id, label: preset.name, brand: group.brand }))
    )
  ], [currentCustomPresetId])
  const selectedPresetOption = useMemo(
    () => presetOptions.find((option) => option.id === trayInfoIdx) ?? presetOptions[0],
    [presetOptions, trayInfoIdx]
  )

  const selectedBambuPreset = BAMBU_FILAMENT_PRESETS.find((preset) => preset.id === trayInfoIdx)
  const selectedPresetBrand = selectedBambuPreset?.brand ?? null
  const loadSpoolAvailability = getExternalSpoolLoadAvailability(status, spool.amsId)
  const unloadSpoolAvailability = getExternalSpoolUnloadAvailability(status, spool.amsId)
  const swatchMaterial = selectedBambuPreset
    ? bambuMaterialFromPresetName(selectedBambuPreset.name)
    : bambuMaterialFromType(type)
  const { swatches: suggestedColorSwatches, usesCommonFallback } = resolveFilamentColorSwatches(swatchMaterial, { presetBrand: selectedPresetBrand })
  const colorSwatches = selectedBambuPreset
    ? suggestedColorSwatches
    : COMMON_FILAMENT_COLOR_SWATCHES
  const colorSwatchTitle = selectedBambuPreset && selectedPresetBrand === 'Bambu' && !usesCommonFallback
    ? `Bambu ${swatchMaterial ?? selectedBambuPreset.type} colors`
    : 'Common filament colors'
  const normalizedColor = normalizeHex(color).toUpperCase()

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <Typography level="h4">{label}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Manual filament slot. It shares the nozzle path with AMS and does not support RFID scan.
        </Typography>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <DialogSection title="Filament">
            <Stack spacing={1.25}>
              <PluginSlot
                name="externalSpool.editor"
                context={{
                  kind: 'external',
                  printerId,
                  amsId: spool.amsId,
                  currentValues: { filamentType: type, colorHex: color, trayInfoIdx },
                  onApplyFilament: applyFilamentFromLibrary
                }}
              />
              <FormControl>
                <FormLabel>Bambu preset</FormLabel>
                <Autocomplete
                  options={presetOptions}
                  value={selectedPresetOption}
                  onChange={(_event, value) => {
                    if (value) applyBambuPreset(value.id)
                  }}
                  getOptionLabel={(option) => option.label}
                  isOptionEqualToValue={(option, value) => option.id === value.id}
                  groupBy={(option) => option.brand}
                  disableClearable
                  selectOnFocus
                  handleHomeEndKeys
                  openOnFocus
                  slotProps={{ listbox: { sx: { maxHeight: 360 } } }}
                  renderOption={(props, option) => (
                    <AutocompleteOption {...props} key={option.id}>
                      <ListItemContent>{option.label}</ListItemContent>
                    </AutocompleteOption>
                  )}
                />
              </FormControl>
              <FormControl>
                <FormLabel>Color</FormLabel>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Input
                    type="color"
                    value={normalizeHex(color)}
                    onChange={(event) => setColor(event.target.value)}
                    slotProps={{ input: { 'aria-label': 'Color' } }}
                    sx={{ width: 56, p: 0.5 }}
                  />
                  <Input
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    placeholder="#RRGGBB"
                    sx={{ flex: 1 }}
                  />
                </Stack>
              </FormControl>
              {colorSwatches.length > 0 && (
                <ColorSwatchPicker
                  title={colorSwatchTitle}
                  swatches={colorSwatches}
                  selectedHex={normalizedColor}
                  onPick={(hex) => setColor(hex)}
                />
              )}
              {trayInfoIdx === '' && (
                <FormControl>
                  <FormLabel>Type</FormLabel>
                  <Select value={type} onChange={(_event, value) => value && applyPreset(value)}>
                    {FILAMENT_PRESETS.map((preset) => (
                      <Option key={preset.type} value={preset.type}>{preset.type}</Option>
                    ))}
                  </Select>
                </FormControl>
              )}
            </Stack>
          </DialogSection>

          <DialogSection
            title="Filament actions"
            description={`Heater target for load/unload defaults to ${defaultNozzleTemp}°C from this spool's configured filament profile.`}
          >
            <Stack spacing={1.25}>
              <ButtonGroup
                size="sm"
                variant="soft"
                color="neutral"
                sx={{
                  width: '100%',
                  '& > *': {
                    flex: 1,
                    minWidth: 0
                  }
                }}
              >
                {withDisabledActionReason(
                  <Button
                    loading={loadSpool.isPending}
                    disabled={unloadSpool.isPending || !loadSpoolAvailability.allowed}
                    onClick={() => loadSpool.mutate()}
                  >
                    Load filament
                  </Button>,
                  unloadSpool.isPending || loadSpool.isPending ? null : loadSpoolAvailability.reason,
                  { fill: true }
                )}
                {withDisabledActionReason(
                  <Button
                    loading={unloadSpool.isPending}
                    disabled={loadSpool.isPending || !unloadSpoolAvailability.allowed}
                    onClick={() => unloadSpool.mutate()}
                  >
                    Unload filament
                  </Button>,
                  loadSpool.isPending || unloadSpool.isPending ? null : unloadSpoolAvailability.reason,
                  { fill: true }
                )}
              </ButtonGroup>
              <FilamentChangeProgressPanel status={status} pendingActionLabel={pendingFilamentActionLabel} />
            </Stack>
          </DialogSection>

          {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ pt: 1 }}>
            <Button
              variant="soft"
              color="danger"
              startDecorator={<RestartAltRoundedIcon />}
              loading={resetSpool.isPending}
              onClick={() => resetSpool.mutate()}
            >
              Reset slot
            </Button>
            <Stack direction="row" spacing={1}>
              <Button variant="plain" onClick={onClose}>Cancel</Button>
              <Button loading={send.isPending} startDecorator={<SaveRoundedIcon />} onClick={() => send.mutate()}>Save</Button>
            </Stack>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}
