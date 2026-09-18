/**
 * AMS slot edit modal extracted from `pages/PrintersView.tsx`. Edits a single
 * AMS slot: Bambu preset/color/type for non-RFID spools (read-only for
 * detected Bambu spools), pressure-advance profile selection/create/edit, and
 * load/unload/rescan/reset filament actions, persisting via the printer
 * command + pressure-advance-profile endpoints.
 */
import { useSlotFilamentIdentityLookup } from '../../lib/slotFilamentIdentity'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AutocompleteOption, Button, ButtonGroup, Divider, FormControl, FormLabel, Input, ListItemContent, ModalDialog, Option, Select, Sheet, Stack, Typography
} from '@mui/joy'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  checkFilamentBlacklistForAssignment,
  hasBambuRfidTag,
  getAmsLoadFilamentAvailability,
  getAmsRescanAvailability,
  getAmsUnloadFilamentAvailability,
  printerPressureAdvanceProfilesResponseSchema,
  type AmsSlot,
  type AmsUnit,
  type PrinterCommand,
  type PrinterPressureAdvanceProfile,
  slotMaterialAllowsPreset,
  slotMaterialCompatibilityError,
  type SlotMaterialIdentity,
  type PrinterStatus
} from '@printstream/shared'
import { ScrollableModalDialog, ScrollableDialogBody } from '../ScrollableDialog'
import { PrinterMaterialSettings } from '../PrinterMaterialSettings'
import { SlotMaterialFields } from '../SlotMaterialFields'
import { slotMaterialDraft, automaticSlotMaterial, genericSlotMaterial, inventorySlotMaterial } from '../../lib/slotMaterialDraft'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'
import { DialogSection } from '../DialogSection'
import { DeferredKeyboardAutocomplete } from '../DeferredKeyboardAutocomplete'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { ColorSwatchPicker } from '../ColorSwatchPicker'
import { AmsSlotBlacklistNotice } from './AmsSlotBlacklistNotice'
import { FilamentChangeProgressPanel } from './FilamentChangeProgressPanel'
import { bambuColorName, bambuMaterialFromPresetName, bambuMaterialFromType } from '../../data/bambuColors'
import { BAMBU_FILAMENT_PRESETS, BAMBU_FILAMENT_PRESET_GROUPS, filamentTypeDefaults } from '../../data/filamentSetupCatalog'
import { PluginSlot } from '../../plugin/PluginSlot'
import { printerMaterialType } from '../../data/printerMaterialType'
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
  printerModel,
  status,
  unit,
  slot,
  defaultNozzleTemp,
  rescanActive,
  onClose
}: {
  printerId: string
  /** Stored model string; the blacklist rules key on it. */
  printerModel: string
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
  const isBambuSpool = hasBambuRfidTag(slot.trayUuid)
  const lookupIdentity = useSlotFilamentIdentityLookup()
  const trackedIdentity = lookupIdentity(printerId, unit.unitId, slot.slot)
  const initialBambuPreset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === slot.trayInfoIdx)
  const [type, setType] = useState<string>(slot.filamentType ?? initialBambuPreset?.type ?? 'PLA')
  const [materialDraft, setMaterialIdentity] = useState<SlotMaterialIdentity | null>(null)
  const materialIdentity = materialDraft ?? slotMaterialDraft({ ...slot, spool: trackedIdentity })
  const [manualIdentity, setManualIdentity] = useState<boolean | null>(null)
  const [color, setColorValue] = useState<string>(slot.color ?? '#000000')
  /** Colour and its optional display name are independent; picker edits preserve the entered name. */
  const setColor = (next: string) => {
    setColorValue(next)
    setMaterialIdentity(materialIdentity)
    setManualIdentity(true)
  }
  const [trayInfoIdx, setTrayInfoIdx] = useState<string>(slot.trayInfoIdx ?? '')
  const [libraryMaterialType, setLibraryMaterialType] = useState<string | null>(null)
  const [librarySpoolLabel, setLibrarySpoolLabel] = useState<string | null>(null)
  const [selectedPaProfile, setSelectedPaProfile] = useState<string>(normalizeSelectedPressureAdvanceProfile(slot.caliIdx))
  const [paEditorMode, setPaEditorMode] = useState<'idle' | 'create' | 'edit'>('idle')
  const [newPaProfileKValue, setNewPaProfileKValue] = useState<string>(slot.k != null ? slot.k.toFixed(3) : '')
  const [newPaProfileName, setNewPaProfileName] = useState<string>('')
  const compatibilityError = slotMaterialCompatibilityError(materialIdentity.filamentType, type, trayInfoIdx)
  const [error, setError] = useState<string | null>(null)
  const [pendingFilamentActionLabel, setPendingFilamentActionLabel] = usePendingFilamentActionLabel(status)
  // The pressure-advance + calibration surface lives behind a button in its own dialog to keep the
  // main slot dialog uncluttered for people who never touch it.
  const [tuningOpen, setTuningOpen] = useState(false)

  /** Derive nozzle temp range from the selected filament type / preset. */
  const tempsForCurrentType = () => {
    const fromBambu = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === trayInfoIdx)
    const preset = (fromBambu?.tempMin != null && fromBambu?.tempMax != null)
      ? { tempMin: fromBambu.tempMin, tempMax: fromBambu.tempMax }
      : filamentTypeDefaults(type)
    if (!preset) throw new Error('Choose a supported printer material before saving.')
    return { tempMin: preset.tempMin, tempMax: preset.tempMax }
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
      // fields are read-only, only the pressure advance selection is editable.
      // Skip setAmsSlot in that case so we never overwrite the detected spool.
      if (!isBambuSpool) {
        if (compatibilityError) throw new Error(compatibilityError)
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
            materialIdentity: (manualIdentity ?? Boolean(slot.materialIdentity || !trackedIdentity?.spoolId)) ? materialIdentity : null,
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
    // RFID spools too, not just custom filament: the only requirement is a
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

  const autoSelectedPaTarget = useRef<string | null>(null)
  useEffect(() => {
    autoSelectedPaTarget.current = null
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
    rescan.mutate()
    onClose()
  }

  const requestResetSlot = () => {
    resetSlot.mutate()
    onClose()
  }


  const applyBambuPreset = (next: string) => {
    setTrayInfoIdx(next)
    const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === next)
    if (!preset) return
    setType(preset.type)
  }

  // Lets the filament-manager plugin's "Pick from library" populate the form.
  const applyFilamentFromLibrary = useCallback((values: { brand?: string | null; colorName?: string | null; filamentType?: string | null; materialSubtype?: string | null; colorHex?: string | null; trayInfoIdx?: string | null; spoolLabel?: string }) => {
    setManualIdentity(false)
    setMaterialIdentity({ brand: values.brand ?? null, filamentType: values.filamentType ?? 'PLA', materialSubtype: values.materialSubtype ?? null, colorName: values.colorName ?? null })
    const printerType = printerMaterialType(values.filamentType, values.materialSubtype)
    const hardware = values.trayInfoIdx ? inventorySlotMaterial(printerType, values.trayInfoIdx) : automaticSlotMaterial({ brand: values.brand ?? null, filamentType: printerType, materialSubtype: values.materialSubtype ?? null })
    setLibraryMaterialType(genericSlotMaterial(printerType)?.type ?? null)
    setLibrarySpoolLabel(values.spoolLabel ?? values.filamentType ?? 'Unknown material')
    setTrayInfoIdx(hardware?.presetId ?? '')
    setType(hardware?.type ?? '')
    if (values.colorHex) setColorValue(values.colorHex)
  }, [])

  const currentCustomPresetId = trayInfoIdx && !BAMBU_FILAMENT_PRESETS.some((preset) => preset.id === trayInfoIdx)
    ? trayInfoIdx
    : null
  const loadFilamentAvailability = getAmsLoadFilamentAvailability(status, unit.unitId, slot.slot)
  const unloadFilamentAvailability = getAmsUnloadFilamentAvailability(status, unit.unitId, slot.slot)
  const rescanAvailability = getAmsRescanAvailability(status, unit.unitId, slot.slot)

  type PresetOption = { id: string; label: string; brand: string }
  const presetOptions = useMemo<PresetOption[]>(() => [
    { id: '', label: 'Custom / no Bambu preset', brand: 'Custom' },
    ...(currentCustomPresetId
      ? [{ id: currentCustomPresetId, label: 'Current custom preset', brand: 'Custom' } as PresetOption]
      : []),
    ...BAMBU_FILAMENT_PRESET_GROUPS.flatMap((group) =>
      group.presets
        .filter((preset) => slotMaterialAllowsPreset(materialIdentity.filamentType, preset.type))
        .map((preset) => ({ id: preset.id, label: preset.name, brand: group.brand }))
    )
  ], [currentCustomPresetId, materialIdentity.filamentType])
  const selectedPresetOption = useMemo(
    () => presetOptions.find((option) => option.id === trayInfoIdx) ?? presetOptions[0],
    [presetOptions, trayInfoIdx]
  )

  const selectedBambuPreset = BAMBU_FILAMENT_PRESETS.find((preset) => preset.id === trayInfoIdx)
  useEffect(() => {
    if (trayInfoIdx === (slot.trayInfoIdx ?? '') || !pressureAdvanceProfilesQuery.isSuccess) return
    if (autoSelectedPaTarget.current === trayInfoIdx) return
    // Studio matches the selected filament's display name against existing printer
    // profiles. This is only a draft selection; Save sends it, never creates a profile.
    const matchingProfile = pressureAdvanceProfilesQuery.data.profiles.find(
      (profile) => profile.name === selectedPresetOption?.label
    )
    setSelectedPaProfile(matchingProfile ? String(matchingProfile.caliIdx) : 'default')
    autoSelectedPaTarget.current = trayInfoIdx
  }, [trayInfoIdx, slot.trayInfoIdx, slot.caliIdx, pressureAdvanceProfilesQuery.isSuccess, pressureAdvanceProfilesQuery.data, selectedPresetOption?.label])

  const selectedPresetBrand = selectedBambuPreset?.brand ?? null
  /**
   * What Bambu says about the material being assigned, for THIS slot's hardware. Graded against the
   * pending selection rather than the loaded spool, so the warning appears while the choice is
   * still being made. It never blocks Save; see `AmsSlotBlacklistNotice` for why.
   */
  const blacklistFindings = useMemo(
    () => checkFilamentBlacklistForAssignment({
      printerModel,
      status,
      amsId: unit.unitId,
      slotId: slot.slot,
      materialIdentity,
      filamentType: type,
      filamentId: trayInfoIdx,
      filamentName: selectedBambuPreset?.name ?? null,
      filamentVendor: selectedBambuPreset?.brand ?? null
    }),
    [printerModel, selectedBambuPreset, slot.slot, status, trayInfoIdx, type, unit.unitId, materialIdentity]
  )
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
  const detectedPresetLabel = filamentPresetLabel(slot.trayInfoIdx, detectedFilament.material, slot.filamentType, { trayUuid: slot.trayUuid })
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
      <ScrollableModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <ScrollableDialogBody>
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
                      Color{detectedFilament.colors.length > 1 ? 's' : ''}: {detectedFilament.colors.length > 0 ? detectedFilament.colors.join(' · ') : slot.color ?? '–'}
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
            <>
                <PluginSlot
                  name="ams.slotEditor"
                  context={{
                    action: 'pick',
                    kind: 'ams',
                    printerId,
                    amsId: unit.unitId,
                    slotId: slot.slot,
                    currentValues: { ...materialIdentity, colorHex: color, trayInfoIdx },
                    onApplyFilament: applyFilamentFromLibrary
                  }}
                />
            <DialogSection title="Material details">
              <Stack spacing={1.25}>
                {libraryMaterialType != null && (
                  <Typography level="body-sm" color={trayInfoIdx ? 'neutral' : 'warning'}>
                    Library spool: {librarySpoolLabel}. The library keeps this identity.
                    {selectedPresetBrand === 'Generic'
                      ? ' Generic is used only for the printer setting.'
                      : ''}
                    {!BAMBU_FILAMENT_PRESETS.some((preset) => preset.type === libraryMaterialType)
                      ? ' Choose a compatible printer preset before continuing.'
                      : ''}
                  </Typography>
                )}
                <AmsSlotBlacklistNotice findings={blacklistFindings} />
                <SlotMaterialFields value={materialIdentity} onChange={(next) => {
                  setMaterialIdentity(next)
                  setManualIdentity(true)
                  setLibraryMaterialType(null)
                  setLibrarySpoolLabel(null)
                  if (next.filamentType !== materialIdentity.filamentType || next.brand !== materialIdentity.brand || next.materialSubtype !== materialIdentity.materialSubtype) {
                    const hardware = automaticSlotMaterial(next)
                    setType(hardware?.type ?? '')
                    setTrayInfoIdx(hardware?.presetId ?? '')
                  }
                }} />
                <Stack spacing={0.5}>
                  <FormLabel>Colour</FormLabel>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Input
                      type="color"
                      value={normalizeHex(color)}
                      onChange={(event) => setColor(event.target.value)}
                      slotProps={{ input: { 'aria-label': 'Colour' } }}
                      sx={{ width: 56, p: 0.5 }}
                    />
                    <Input
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                      placeholder="#RRGGBB"
                      slotProps={{ input: { 'aria-label': 'Colour hex' } }}
                      sx={{ flex: 1 }}
                    />
                  </Stack>
                  {selectedColorName && (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      Known color: {selectedColorName}
                    </Typography>
                  )}
                </Stack>
                {colorSwatches.length > 0 && (
                  <ColorSwatchPicker
                    title={colorSwatchTitle}
                    swatches={colorSwatches}
                    selectedHex={normalizedColor}
                    onPick={(hex) => setColor(hex)}
                  />
                )}
                <PrinterMaterialSettings error={compatibilityError} libraryAction={
                  <PluginSlot
                  name="ams.slotEditor"
                  context={{
                    action: 'save',
                    kind: 'ams',
                    printerId,
                    amsId: unit.unitId,
                    slotId: slot.slot,
                    currentValues: { ...materialIdentity, colorHex: color, trayInfoIdx },
                    onApplyFilament: applyFilamentFromLibrary
                  }}
                />
                }>
                  <FormControl>
                    <FormLabel>Printer material preset</FormLabel>

                    <DeferredKeyboardAutocomplete
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
                    {compatibilityError && <Typography level="body-xs" color="danger">{compatibilityError}</Typography>}
                  </FormControl>
                </PrinterMaterialSettings>

              </Stack>
            </DialogSection>
            </>
          )}

          <Button
            size="sm"
            variant="soft"
            color="neutral"
            fullWidth
            onClick={() => setTuningOpen(true)}
          >
            Pressure advance &amp; calibration…
          </Button>

          <Modal open={tuningOpen} onClose={() => setTuningOpen(false)}>
            <ModalDialog sx={{ maxWidth: 480, width: '100%', maxHeight: '90dvh', overflow: 'auto' }}>
              <Typography level="h4">Pressure advance &amp; calibration</Typography>
              <Typography level="body-sm" textColor="text.tertiary">
                AMS {amsUnitLetter(unit.unitId)}{slot.slot + 1}{slot.filamentType ? ` · ${slot.filamentType}` : ''}
              </Typography>
              <Stack spacing={2} sx={{ mt: 1 }}>
                <PluginSlot
                  name="printer.amsSlot.calibration"
                  context={{
                    printerId,
                    amsId: unit.unitId,
                    slotId: slot.slot,
                    filamentType: slot.filamentType,
                    trayInfoIdx: slot.trayInfoIdx,
                    label: `AMS ${amsUnitLetter(unit.unitId)} slot ${slot.slot + 1}${slot.filamentType ? ` (${slot.filamentType})` : ''}`
                  }}
                />
          <DialogSection
            title="Bambu Studio: printer profile"
            description="Store a calibrated K value on the printer. Only supports Bambu-curated material presets, and is only applied as a fallback when there is no K value applied elsewhere, such as in a material preset or a PrintStream calibration."
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
                <Stack direction="row" justifyContent="flex-end" sx={{ pt: 0.5 }}>
                  <Button variant="plain" color="neutral" onClick={() => setTuningOpen(false)}>Close</Button>
                </Stack>
              </Stack>
            </ModalDialog>
          </Modal>

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
          <DialogSection title="Slot actions">
          <Stack direction="row" spacing={1}>
            {withDisabledActionReason(
              <Button
                variant="soft"
                color="neutral"
                startDecorator={<RefreshRoundedIcon />}
                fullWidth
                loading={rescan.isPending || rescanActive}
                disabled={!rescanAvailability.allowed}
                onClick={requestRescan}
              >
                Rescan
              </Button>,
              rescan.isPending || rescanActive ? null : rescanAvailability.reason,
              { fill: true }
            )}
            {!isBambuSpool && (
              <Button
                variant="soft"
                color="danger"
                startDecorator={<RestartAltRoundedIcon />}
                fullWidth
                loading={resetSlot.isPending}
                onClick={requestResetSlot}
              >
                Reset slot
              </Button>
            )}
          </Stack>
          </DialogSection>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
            <Stack direction="row" spacing={1}>
              <Button variant="plain" onClick={onClose}>
                {isBambuSpool ? 'Close' : 'Cancel'}
              </Button>
              <Button
                loading={send.isPending}
                disabled={(!isBambuSpool && Boolean(compatibilityError)) || deletePressureAdvanceProfile.isPending || (paEditorMode !== 'idle' && !isPressureAdvanceDraftValid) || (canManagePressureAdvanceProfiles && !selectedPaProfileExists && paEditorMode === 'idle')}
                startDecorator={<SaveRoundedIcon />}
                onClick={() => send.mutate()}
              >
                {isBambuSpool ? 'Save profile' : 'Save'}
              </Button>
            </Stack>
          </Stack>
        </Stack>
        </ScrollableDialogBody>
      </ScrollableModalDialog>
    </Modal>
  )
}
