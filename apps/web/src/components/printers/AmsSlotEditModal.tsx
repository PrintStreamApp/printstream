/**
 * AMS slot edit modal extracted from `pages/PrintersView.tsx`. Edits a single
 * AMS slot: Bambu preset/color/type for non-RFID spools (read-only for
 * detected Bambu spools), pressure-advance profile selection/create/edit, and
 * load/unload/rescan/reset filament actions, persisting via the printer
 * command + pressure-advance-profile endpoints.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Autocomplete, AutocompleteOption, Button, ButtonGroup, Divider, FormControl, FormLabel, IconButton, Input, ListItemContent, Menu, MenuItem, ModalDialog, Option, Select, Sheet, Stack, Typography
} from '@mui/joy'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAmsLoadFilamentAvailability,
  getAmsUnloadFilamentAvailability,
  printerPressureAdvanceProfilesResponseSchema,
  type AmsSlot,
  type AmsUnit,
  type PrinterCommand,
  type PrinterPressureAdvanceProfile,
  type PrinterStatus
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'
import { DialogSection } from '../DialogSection'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { ColorSwatchPicker } from '../ColorSwatchPicker'
import { FilamentChangeProgressPanel } from './FilamentChangeProgressPanel'
import { useControlledMenuClickAway } from '../../hooks/useControlledMenuClickAway'
import { bambuColorName, bambuMaterialFromPresetName, bambuMaterialFromType } from '../../data/bambuColors'
import { BAMBU_FILAMENT_PRESETS, BAMBU_FILAMENT_PRESET_GROUPS, FILAMENT_PRESETS, filamentTypeDefaults } from '../../data/filamentSetupCatalog'
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  commonFilamentColorName,
  filamentBackground,
  filamentTextColor,
  hasLoadedFilament,
  isRawTrayCode,
  resolveFilamentColorSwatches,
  resolveFilamentDisplay
} from '../../lib/filamentColor'
import { amsUnitLetter } from '../../lib/printerTrayMapping'
import { filamentPresetLabel, normalizeHex } from '../../lib/printersViewHelpers'
import { usePendingFilamentActionLabel, withDisabledActionReason } from './printerActionHelpers'

export function AmsSlotEditModal({
  printerId,
  status,
  unit,
  slot,
  defaultNozzleTemp,
  rescanActive,
  onClose
}: {
  printerId: string
  status: PrinterStatus | undefined
  unit: AmsUnit
  slot: AmsSlot
  defaultNozzleTemp: number
  rescanActive: boolean
  onClose: () => void
}) {
  const normalizeSelectedPressureAdvanceProfile = (caliIdx: number | null | undefined): string => (
    caliIdx == null || caliIdx < 0 ? 'default' : String(caliIdx)
  )

  const queryClient = useQueryClient()
  const isBambuSpool = slot.trayUuid != null
  const initialBambuPreset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === slot.trayInfoIdx)
  const [type, setType] = useState<string>(slot.filamentType ?? initialBambuPreset?.type ?? 'PLA')
  const [color, setColor] = useState<string>(slot.color ?? '#000000')
  const [trayInfoIdx, setTrayInfoIdx] = useState<string>(slot.trayInfoIdx ?? '')
  const [selectedPaProfile, setSelectedPaProfile] = useState<string>(normalizeSelectedPressureAdvanceProfile(slot.caliIdx))
  const [paEditorMode, setPaEditorMode] = useState<'idle' | 'create' | 'edit'>('idle')
  const [newPaProfileKValue, setNewPaProfileKValue] = useState<string>(slot.k != null ? slot.k.toFixed(3) : '')
  const [newPaProfileName, setNewPaProfileName] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [pendingFilamentActionLabel, setPendingFilamentActionLabel] = usePendingFilamentActionLabel(status)
  // Split-button state for the Rescan / Reset slot menu. Following Joy's
  // canonical SplitButton example (anchor ref + open flag + Menu with
  // `anchorEl`) sidesteps the z-index quirks of `Dropdown` inside a Modal.
  const [rescanMenuOpen, setRescanMenuOpen] = useState(false)
  const rescanAnchorRef = useRef<HTMLDivElement>(null)
  useControlledMenuClickAway(rescanMenuOpen, 'slot-actions-menu', () => setRescanMenuOpen(false), [rescanAnchorRef])

  /** Derive nozzle temp range from the selected filament type / preset. */
  const tempsForCurrentType = () => {
    const fromBambu = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === trayInfoIdx)
    const preset = (fromBambu?.tempMin != null && fromBambu?.tempMax != null)
      ? { tempMin: fromBambu.tempMin, tempMax: fromBambu.tempMax }
      : filamentTypeDefaults(type)
    return { tempMin: preset?.tempMin ?? 190, tempMax: preset?.tempMax ?? 230 }
  }

  const fetchPressureAdvanceProfiles = async () => {
    const params = new URLSearchParams({
      amsId: String(unit.unitId),
      slotId: String(slot.slot),
      filamentId: trayInfoIdx
    })
    const response = await apiFetch(`/api/printers/${printerId}/pressure-advance-profiles?${params.toString()}`)
    return printerPressureAdvanceProfilesResponseSchema.parse(response)
  }

  const applySelectedPressureAdvanceProfile = async (profileId: string) => {
    await apiFetch(`/api/printers/${printerId}/command`, {
      method: 'POST',
      body: {
        type: 'selectAmsPressureAdvanceProfile',
        amsId: unit.unitId,
        slotId: slot.slot,
        caliIdx: profileId === 'default' ? -1 : Number(profileId),
        filamentId: trayInfoIdx
      }
    })
  }

  const resetPressureAdvanceEditor = useCallback(() => {
    setPaEditorMode('idle')
    setNewPaProfileName('')
    setNewPaProfileKValue(slot.k != null ? slot.k.toFixed(3) : '')
  }, [slot.k])

  const send = useMutation({
    mutationFn: async () => {
      // A Bambu RFID spool reports its own filament/color/temps, so the slot
      // fields are read-only — only the pressure advance selection is editable.
      // Skip setAmsSlot in that case so we never overwrite the detected spool.
      if (!isBambuSpool) {
        const trayColor = color.replace('#', '').padEnd(8, 'F').slice(0, 8).toUpperCase()
        const { tempMin, tempMax } = tempsForCurrentType()
        await apiFetch(`/api/printers/${printerId}/command`, {
          method: 'POST',
          body: {
            type: 'setAmsSlot',
            amsId: unit.unitId,
            slotId: slot.slot,
            trayInfoIdx,
            trayColor,
            trayType: type,
            nozzleTempMin: tempMin,
            nozzleTempMax: tempMax
          }
        })
      }
      let profileToApply = selectedPaProfile
      if (canManagePressureAdvanceProfiles) {
        if (paEditorMode !== 'idle') {
          const parsed = Number(newPaProfileKValue)
          if (!Number.isFinite(parsed)) {
            throw new Error('K value must be a number')
          }

          const trimmedProfileName = newPaProfileName.trim()
          if (trimmedProfileName === '') {
            throw new Error('Profile name is required')
          }

          if (paEditorMode === 'edit' && selectedSavedPaProfile) {
            await apiFetch(`/api/printers/${printerId}/command`, {
              method: 'POST',
              body: {
                type: 'deleteAmsPressureAdvanceProfile',
                amsId: unit.unitId,
                slotId: slot.slot,
                caliIdx: selectedSavedPaProfile.caliIdx,
                filamentId: selectedSavedPaProfile.filamentId,
                nozzleDiameter: selectedSavedPaProfile.nozzleDiameter ?? '0.4',
                extruderId: 0
              } satisfies Extract<PrinterCommand, { type: 'deleteAmsPressureAdvanceProfile' }>
            })
          }

          await apiFetch(`/api/printers/${printerId}/command`, {
            method: 'POST',
            body: {
              type: 'createAmsPressureAdvanceProfile',
              amsId: unit.unitId,
              slotId: slot.slot,
              kValue: parsed,
              filamentId: trayInfoIdx,
              settingId: selectedSavedPaProfile?.settingId ?? '',
              profileName: trimmedProfileName,
              nozzleDiameter: selectedSavedPaProfile?.nozzleDiameter ?? '0.4',
              extruderId: 0
            } satisfies Extract<PrinterCommand, { type: 'createAmsPressureAdvanceProfile' }>
          })

          const refreshedProfiles = await fetchPressureAdvanceProfiles()
          const createdProfile = [...refreshedProfiles.profiles]
            .sort((left, right) => right.caliIdx - left.caliIdx)
            .find((profile) => {
              const profileName = profile.name?.trim() ?? ''
              return profile.filamentId === trayInfoIdx
                && profileName === trimmedProfileName
                && Math.abs(profile.kValue - parsed) < 0.0005
            })

          if (!createdProfile) {
            throw new Error('Profile was saved but could not be found afterward')
          }

          profileToApply = String(createdProfile.caliIdx)
        }

        if (profileToApply === 'default' || selectedPaProfileExists || paEditorMode !== 'idle') {
          await applySelectedPressureAdvanceProfile(profileToApply)
        }
      }

      return { profileToApply }
    },
    onSuccess: async ({ profileToApply }) => {
      setError(null)
      setSelectedPaProfile(profileToApply)
      resetPressureAdvanceEditor()
      await queryClient.invalidateQueries({ queryKey: pressureAdvanceProfilesQueryKey })
      void queryClient.invalidateQueries({ queryKey: ['printer-status'] })
      onClose()
    },
    onError: (err: Error) => setError(err.message)
  })

  const resetSlot = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: { type: 'resetAmsSlot', amsId: unit.unitId, slotId: slot.slot }
      }),
    onSuccess: () => {
      toast.success('Slot reset')
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const loadFilament = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'loadAmsFilament',
          amsId: unit.unitId,
          slotId: slot.slot,
          extruderId: unit.nozzleId ?? undefined,
          nozzleTemp: defaultNozzleTemp
        }
      }),
    onSuccess: () => {
      setError(null)
      setPendingFilamentActionLabel('Loading filament')
      toast.success(`AMS ${amsUnitLetter(unit.unitId)}${slot.slot + 1} load requested`)
    },
    onError: (err: Error) => setError(err.message)
  })

  const unloadFilament = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'unloadAmsFilament',
          amsId: unit.unitId,
          slotId: slot.slot,
          extruderId: unit.nozzleId ?? undefined,
          nozzleTemp: defaultNozzleTemp
        }
      }),
    onSuccess: () => {
      setError(null)
      setPendingFilamentActionLabel('Unloading filament')
      toast.success(`AMS ${amsUnitLetter(unit.unitId)}${slot.slot + 1} unload requested`)
    },
    onError: (err: Error) => setError(err.message)
  })

  const pressureAdvanceProfilesQueryKey = ['printer-pressure-advance-profiles', printerId, unit.unitId, slot.slot, trayInfoIdx] as const
  const pressureAdvanceProfilesQuery = useQuery({
    queryKey: pressureAdvanceProfilesQueryKey,
    // Pressure advance (flow dynamics / K-value) calibration applies to Bambu
    // RFID spools too, not just custom filament — the only requirement is a
    // known filament id to scope the profiles to.
    enabled: trayInfoIdx !== '',
    queryFn: fetchPressureAdvanceProfiles
  })
  const pressureAdvanceProfiles: PrinterPressureAdvanceProfile[] = pressureAdvanceProfilesQuery.data?.profiles ?? []
  const canManagePressureAdvanceProfiles = trayInfoIdx !== ''
  const selectedSavedPaProfile = selectedPaProfile === 'default'
    ? null
    : pressureAdvanceProfiles.find((profile) => String(profile.caliIdx) === selectedPaProfile) ?? null
  const isEditingPressureAdvanceProfile = paEditorMode === 'edit'
  const selectedPaProfileExists = selectedPaProfile === 'default'
    || pressureAdvanceProfiles.some((profile) => String(profile.caliIdx) === selectedPaProfile)
  const isPressureAdvanceDraftValid = newPaProfileName.trim() !== '' && Number.isFinite(Number(newPaProfileKValue))

  const pressureAdvanceProfileLabel = (profile: Pick<PrinterPressureAdvanceProfile, 'caliIdx' | 'kValue' | 'name'>) => {
    const profileName = profile.name && profile.name.trim() !== '' ? profile.name : `Profile ${profile.caliIdx}`
    return `${profileName} · K ${profile.kValue.toFixed(3)}`
  }

  useEffect(() => {
    setSelectedPaProfile(
      trayInfoIdx === (slot.trayInfoIdx ?? '')
        ? normalizeSelectedPressureAdvanceProfile(slot.caliIdx)
        : 'default'
    )
  }, [slot.caliIdx, slot.trayInfoIdx, trayInfoIdx])

  useEffect(() => {
    setNewPaProfileKValue(slot.k != null ? slot.k.toFixed(3) : '')
  }, [slot.k])

  useEffect(() => {
    resetPressureAdvanceEditor()
  }, [resetPressureAdvanceEditor, trayInfoIdx])

  const deletePressureAdvanceProfile = useMutation({
    mutationFn: () => {
      if (!selectedSavedPaProfile) {
        return Promise.reject(new Error('Select a saved profile to delete'))
      }
      return apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'deleteAmsPressureAdvanceProfile',
          amsId: unit.unitId,
          slotId: slot.slot,
          caliIdx: selectedSavedPaProfile.caliIdx,
          filamentId: selectedSavedPaProfile.filamentId,
          nozzleDiameter: selectedSavedPaProfile.nozzleDiameter ?? '0.4',
          extruderId: 0
        } satisfies Extract<PrinterCommand, { type: 'deleteAmsPressureAdvanceProfile' }>
      })
    },
    onSuccess: async () => {
      setError(null)
      setSelectedPaProfile('default')
      resetPressureAdvanceEditor()
      await queryClient.invalidateQueries({ queryKey: pressureAdvanceProfilesQueryKey })
      void queryClient.invalidateQueries({ queryKey: ['printer-status'] })
    },
    onError: (err: Error) => setError(err.message)
  })

  const startCreatingPressureAdvanceProfile = () => {
    setPaEditorMode('create')
    setNewPaProfileName('')
    setNewPaProfileKValue(slot.k != null ? slot.k.toFixed(3) : '')
  }

  const startEditingPressureAdvanceProfile = () => {
    if (!selectedSavedPaProfile) return
    setPaEditorMode('edit')
    setNewPaProfileName(selectedSavedPaProfile.name?.trim() || `Profile ${selectedSavedPaProfile.caliIdx}`)
    setNewPaProfileKValue(selectedSavedPaProfile.kValue.toFixed(3))
  }

  const cancelEditingPressureAdvanceProfile = () => {
    resetPressureAdvanceEditor()
  }

  const rescan = useMutation({
    mutationFn: () =>
      apiFetch(`/api/printers/${printerId}/command`, {
        method: 'POST',
        body: {
          type: 'rescanAmsSlot',
          amsId: unit.unitId,
          slotId: slot.slot
        }
      }),
    onSuccess: () => {
      toast.success('Rescan requested')
    },
    onError: (err: Error) => toast.error(err.message)
  })

  const requestRescan = () => {
    setRescanMenuOpen(false)
    rescan.mutate()
    onClose()
  }

  const requestResetSlot = () => {
    setRescanMenuOpen(false)
    resetSlot.mutate()
    onClose()
  }

  const applyPreset = (next: string) => {
    setType(next)
  }

  const applyBambuPreset = (next: string) => {
    setTrayInfoIdx(next)
    const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === next)
    if (!preset) return
    setType(preset.type)
  }

  const currentCustomPresetId = trayInfoIdx && !BAMBU_FILAMENT_PRESETS.some((preset) => preset.id === trayInfoIdx)
    ? trayInfoIdx
    : null
  const loadFilamentAvailability = getAmsLoadFilamentAvailability(status, unit.unitId, slot.slot)
  const unloadFilamentAvailability = getAmsUnloadFilamentAvailability(status, unit.unitId, slot.slot)

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
  const detectedFilament = resolveFilamentDisplay(slot)
  const detectedPresetLabel = filamentPresetLabel(slot.trayInfoIdx, detectedFilament.material, slot.filamentType)
  const detectedColorName = detectedFilament.name
  const detectedHeaderBg = filamentBackground(detectedFilament.colors, slot.color, 'var(--joy-palette-neutral-700)')
  const detectedHeaderFg = filamentTextColor(detectedFilament.colors, slot.color, 'var(--joy-palette-text-primary)')
  const showDetectedTrayName = Boolean(
    slot.trayName
    && slot.trayName !== slot.filamentType
    && slot.trayName !== detectedPresetLabel
    && slot.trayName !== detectedColorName
    && !isRawTrayCode(slot.trayName)
  )
  const showDetectedTrayCode = Boolean(slot.trayName && isRawTrayCode(slot.trayName))
  const hasFilament = hasLoadedFilament(slot.filamentType, slot.color, slot.colors, {
    trayInfoIdx: slot.trayInfoIdx,
    trayName: slot.trayName,
    trayUuid: slot.trayUuid,
    remainPercent: slot.remainPercent
  })
  const remainGrams = hasFilament && slot.remainPercent != null ? Math.round(slot.remainPercent * 10) : null
  const selectedColorName = selectedPresetBrand === 'Bambu'
    ? bambuColorName(normalizedColor, swatchMaterial) ?? commonFilamentColorName(normalizedColor)
    : commonFilamentColorName(normalizedColor) ?? (!selectedBambuPreset ? bambuColorName(normalizedColor, swatchMaterial) : null)

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <Typography level="h4">AMS {amsUnitLetter(unit.unitId)}{slot.slot + 1}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {isBambuSpool ? 'Bambu spool detected (read-only)' : 'Edit filament details'}
        </Typography>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {isBambuSpool ? (
            <DialogSection title="Detected filament" wrapInSheet={false}>
              <Sheet variant="soft" sx={{ borderRadius: 'sm', overflow: 'hidden' }}>
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{
                    px: 1.25,
                    py: 1,
                    background: detectedHeaderBg,
                    color: detectedHeaderFg,
                    borderBottom: '1px solid rgba(0, 0, 0, 0.25)'
                  }}
                >
                  <Typography level="title-sm" sx={{ color: 'inherit', fontWeight: 'lg', flex: 1, minWidth: 0 }} noWrap>
                    {detectedColorName ?? (hasFilament ? 'Custom colour' : 'Empty')}
                  </Typography>
                </Stack>
                <Stack spacing={0.75} sx={{ px: 1.25, py: 1 }}>
                  <Typography level="body-sm">
                    {detectedPresetLabel ?? detectedFilament.material ?? slot.filamentType ?? 'Bambu filament'}
                  </Typography>
                  {showDetectedTrayName && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      {slot.trayName}
                    </Typography>
                  )}
                  {showDetectedTrayCode && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Bambu code: {slot.trayName}
                    </Typography>
                  )}
                  {(detectedFilament.colors.length > 1 || (!detectedColorName && slot.color)) && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Color{detectedFilament.colors.length > 1 ? 's' : ''}: {detectedFilament.colors.length > 0 ? detectedFilament.colors.join(' · ') : slot.color ?? '—'}
                    </Typography>
                  )}
                  {hasFilament && slot.remainPercent != null && remainGrams != null && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Remaining: {Math.round(slot.remainPercent)}% (~{remainGrams}g)
                    </Typography>
                  )}
                </Stack>
              </Sheet>
            </DialogSection>
          ) : (
            <DialogSection title="Filament">
              <Stack spacing={1.25}>
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
                  {selectedColorName && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Known color: {selectedColorName}
                    </Typography>
                  )}
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
          )}

          <DialogSection
            title="Pressure advance"
            description="Default uses the printer's built-in behavior. Profiles are tied to the selected filament preset and keep their own custom names."
          >
              <Stack spacing={1.25}>
                <Typography level="body-xs" textColor="text.tertiary">
                  Preset: {trayInfoIdx !== '' ? (selectedPresetOption?.label ?? 'Selected preset') : 'Select a filament preset first'}
                </Typography>
                <FormControl>
                  <FormLabel>Selected profile</FormLabel>
                  <Select
                    value={selectedPaProfile}
                    onChange={(_event, value) => value && setSelectedPaProfile(value)}
                    disabled={!canManagePressureAdvanceProfiles || pressureAdvanceProfilesQuery.isLoading || deletePressureAdvanceProfile.isPending}
                    renderValue={(option) => (
                      <Typography level="body-sm" noWrap title={typeof option?.label === 'string' ? option.label : undefined}>
                        {option?.label ?? 'Default'}
                      </Typography>
                    )}
                    slotProps={{
                      button: {
                        sx: {
                          minWidth: 0,
                          overflow: 'hidden'
                        }
                      }
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    <Option value="default">Default</Option>
                    {pressureAdvanceProfiles.map((profile) => (
                      <Option key={profile.caliIdx} value={String(profile.caliIdx)}>
                        <Typography level="body-sm" noWrap title={pressureAdvanceProfileLabel(profile)}>
                          {pressureAdvanceProfileLabel(profile)}
                        </Typography>
                      </Option>
                    ))}
                  </Select>
                  {!canManagePressureAdvanceProfiles && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Select a Bambu preset to load the saved profiles for that preset.
                    </Typography>
                  )}
                  {canManagePressureAdvanceProfiles && (
                    <ButtonGroup size="sm" variant="soft" color="neutral" sx={{ alignSelf: 'flex-start', mt: 1 }}>
                      <Button disabled={deletePressureAdvanceProfile.isPending || send.isPending} onClick={startCreatingPressureAdvanceProfile}>
                        New
                      </Button>
                      <Button
                        disabled={!selectedSavedPaProfile || deletePressureAdvanceProfile.isPending || send.isPending}
                        onClick={startEditingPressureAdvanceProfile}
                      >
                        Edit
                      </Button>
                      <Button
                        color="danger"
                        disabled={!selectedSavedPaProfile || send.isPending}
                        loading={deletePressureAdvanceProfile.isPending}
                        onClick={() => deletePressureAdvanceProfile.mutate()}
                      >
                        Delete
                      </Button>
                    </ButtonGroup>
                  )}
                  {pressureAdvanceProfilesQuery.isLoading && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Loading saved profiles…
                    </Typography>
                  )}
                  {pressureAdvanceProfilesQuery.isError && (
                    <Typography level="body-xs" color="danger" sx={{ mt: 0.5 }}>
                      {(pressureAdvanceProfilesQuery.error as Error).message}
                    </Typography>
                  )}
                  {!pressureAdvanceProfilesQuery.isLoading && !pressureAdvanceProfilesQuery.isError && pressureAdvanceProfiles.length === 0 && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      No saved profiles reported for this filament yet.
                    </Typography>
                  )}
                </FormControl>
                {paEditorMode !== 'idle' && (
                  <>
                    <Divider />
                    <FormControl>
                      <FormLabel>{isEditingPressureAdvanceProfile ? 'Edit profile' : 'New profile'}</FormLabel>
                      <Input
                        value={newPaProfileName}
                        onChange={(event) => setNewPaProfileName(event.target.value)}
                        placeholder="Custom profile name"
                        disabled={!canManagePressureAdvanceProfiles || deletePressureAdvanceProfile.isPending || send.isPending}
                      />
                      <Input
                        type="number"
                        value={newPaProfileKValue}
                        onChange={(event) => setNewPaProfileKValue(event.target.value)}
                        placeholder={slot.k != null ? slot.k.toFixed(3) : '0.020'}
                        slotProps={{ input: { step: 0.001, min: 0, max: 2 } }}
                        disabled={!canManagePressureAdvanceProfiles || deletePressureAdvanceProfile.isPending || send.isPending}
                      />
                      <Button
                        size="sm"
                        variant="plain"
                        sx={{ alignSelf: 'flex-end' }}
                        disabled={send.isPending || deletePressureAdvanceProfile.isPending}
                        onClick={cancelEditingPressureAdvanceProfile}
                      >
                        Cancel {isEditingPressureAdvanceProfile ? 'edit' : 'new profile'}
                      </Button>
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                        {isEditingPressureAdvanceProfile
                          ? 'Save replaces the selected profile and applies the replacement.'
                          : 'Save creates the new named profile and applies it.'}
                      </Typography>
                    </FormControl>
                  </>
                )}
              </Stack>
            </DialogSection>

          <DialogSection
            title="Filament actions"
            description={`Heater target for load/unload defaults to ${defaultNozzleTemp}°C from this slot's configured filament profile.`}
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
                    loading={loadFilament.isPending}
                    disabled={unloadFilament.isPending || !loadFilamentAvailability.allowed}
                    onClick={() => loadFilament.mutate()}
                  >
                    Load filament
                  </Button>,
                  unloadFilament.isPending || loadFilament.isPending ? null : loadFilamentAvailability.reason,
                  { fill: true }
                )}
                {withDisabledActionReason(
                  <Button
                    loading={unloadFilament.isPending}
                    disabled={loadFilament.isPending || !unloadFilamentAvailability.allowed}
                    onClick={() => unloadFilament.mutate()}
                  >
                    Unload filament
                  </Button>,
                  loadFilament.isPending || unloadFilament.isPending ? null : unloadFilamentAvailability.reason,
                  { fill: true }
                )}
              </ButtonGroup>
              <FilamentChangeProgressPanel status={status} pendingActionLabel={pendingFilamentActionLabel} />
            </Stack>
          </DialogSection>

          {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ pt: 1 }}>
            {isBambuSpool ? (
              <Button
                variant="soft"
                color="neutral"
                startDecorator={<RefreshRoundedIcon />}
                loading={rescan.isPending || rescanActive}
                onClick={requestRescan}
              >
                Rescan
              </Button>
            ) : (
              <>
                <ButtonGroup
                  ref={rescanAnchorRef}
                  variant="soft"
                  color="neutral"
                  aria-label="rescan / reset slot"
                >
                  <Button
                    startDecorator={<RefreshRoundedIcon />}
                    loading={rescan.isPending || rescanActive}
                    onClick={requestRescan}
                  >
                    Rescan
                  </Button>
                  <IconButton
                    aria-controls={rescanMenuOpen ? 'slot-actions-menu' : undefined}
                    aria-expanded={rescanMenuOpen ? 'true' : undefined}
                    aria-haspopup="menu"
                    aria-label="More slot actions"
                    onClick={() => setRescanMenuOpen((value) => !value)}
                  >
                    <ArrowDropDownIcon />
                  </IconButton>
                </ButtonGroup>
                <Menu
                  id="slot-actions-menu"
                  open={rescanMenuOpen}
                  onClose={() => setRescanMenuOpen(false)}
                  anchorEl={rescanAnchorRef.current}
                  placement="bottom-end"
                  // Joy's tooltip token (1500) is the only built-in layer
                  // that beats `modal` (1300), so a popper opened from
                  // inside a Modal renders above the dialog.
                  sx={{ zIndex: (theme) => theme.zIndex.tooltip }}
                >
                  <MenuItem
                    color="danger"
                    onClick={requestResetSlot}
                  >
                    <RestartAltRoundedIcon fontSize="small" />
                    Reset slot
                  </MenuItem>
                </Menu>
              </>
            )}
            <Stack direction="row" spacing={1}>
              <Button variant="plain" onClick={onClose}>
                {isBambuSpool ? 'Close' : 'Cancel'}
              </Button>
              <Button
                loading={send.isPending}
                disabled={deletePressureAdvanceProfile.isPending || (paEditorMode !== 'idle' && !isPressureAdvanceDraftValid) || (canManagePressureAdvanceProfiles && !selectedPaProfileExists && paEditorMode === 'idle')}
                startDecorator={<SaveRoundedIcon />}
                onClick={() => send.mutate()}
              >
                {isBambuSpool ? 'Save profile' : 'Save'}
              </Button>
            </Stack>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}
