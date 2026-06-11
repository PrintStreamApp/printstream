/**
 * Compact "set up this spool" dialog for AMS slots and external spools, reachable from
 * print-flow tray pickers (PrintModal, printer-storage print) when a slot holds an
 * unrecognized spool. Sends the same `setAmsSlot` / `setExternalSpool` printer commands
 * as the printers view's full slot editor; the new identity arrives back through the
 * next status event (commands are fire-and-forget).
 */
import { useState } from 'react'
import {
  Alert,
  Button,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Typography
} from '@mui/joy'
import { apiFetch } from '../lib/apiClient'
import { toast } from '../lib/toast'
import {
  BAMBU_FILAMENT_PRESETS,
  BAMBU_FILAMENT_PRESET_GROUPS,
  FILAMENT_PRESETS,
  filamentTypeDefaults
} from '../data/filamentSetupCatalog'
import { bambuMaterialFromPresetName, bambuMaterialFromType } from '../data/bambuColors'
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  commonFilamentColorName,
  resolveFilamentColorSwatches
} from '../lib/filamentColor'
import { ColorSwatchPicker } from './ColorSwatchPicker'

export interface AmsSpoolSetupTarget {
  printerId: string
  /** AMS slots use `setAmsSlot`; external spools use `setExternalSpool`. */
  kind: 'ams' | 'external'
  /** AMS unit id, or the external spool's virtual tray id (254/255). */
  amsId: number
  /** 0-based slot within the AMS unit (AMS only). */
  slotId?: number
  /** Human label for the dialog title, e.g. `AMS A2` or `External spool`. */
  label: string
  initial?: { filamentType?: string | null; color?: string | null; trayInfoIdx?: string | null }
}

function normalizeHex(value: string): string {
  const hex = value.trim().replace(/^#/, '')
  return `#${hex.padEnd(6, '0').slice(0, 6)}`.toUpperCase()
}

export function AmsSpoolSetupDialog({ target, onClose }: { target: AmsSpoolSetupTarget; onClose: () => void }) {
  const initialPreset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === target.initial?.trayInfoIdx)
  const [trayInfoIdx, setTrayInfoIdx] = useState<string>(target.initial?.trayInfoIdx ?? '')
  const [type, setType] = useState<string>(target.initial?.filamentType ?? initialPreset?.type ?? 'PLA')
  const [color, setColor] = useState<string>(target.initial?.color ?? '#000000')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const selectedPreset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === trayInfoIdx)
  const swatchMaterial = selectedPreset
    ? bambuMaterialFromPresetName(selectedPreset.name)
    : bambuMaterialFromType(type)
  const { swatches } = resolveFilamentColorSwatches(swatchMaterial, { presetBrand: selectedPreset?.brand ?? null })
  const colorSwatches = selectedPreset ? swatches : COMMON_FILAMENT_COLOR_SWATCHES
  const normalizedColor = normalizeHex(color)
  const colorName = commonFilamentColorName(normalizedColor)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === trayInfoIdx)
      const temps = (preset?.tempMin != null && preset?.tempMax != null)
        ? { tempMin: preset.tempMin, tempMax: preset.tempMax }
        : filamentTypeDefaults(preset?.type ?? type) ?? { tempMin: 190, tempMax: 230 }
      const trayColor = normalizedColor.replace('#', '').padEnd(8, 'F').slice(0, 8).toUpperCase()
      const trayType = preset?.type ?? type
      await apiFetch(`/api/printers/${target.printerId}/command`, {
        method: 'POST',
        body: target.kind === 'ams'
          ? {
            type: 'setAmsSlot',
            amsId: target.amsId,
            slotId: target.slotId ?? 0,
            trayInfoIdx,
            trayColor,
            trayType,
            nozzleTempMin: temps.tempMin,
            nozzleTempMax: temps.tempMax
          }
          : {
            type: 'setExternalSpool',
            amsId: target.amsId,
            trayInfoIdx,
            trayColor,
            trayType,
            nozzleTempMin: temps.tempMin,
            nozzleTempMax: temps.tempMax
          }
      })
      toast.success(`Updated ${target.label}. The slot refreshes with the printer's next status update.`)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update the spool.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 400, width: '100%' }}>
        <Typography level="h4">Set up {target.label}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Tell the printer what is loaded in this slot so it can be mapped to the print.
        </Typography>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          <FormControl>
            <FormLabel>Filament</FormLabel>
            <Select
              value={trayInfoIdx}
              onChange={(_event, value) => {
                if (value == null) return
                setTrayInfoIdx(value)
                const preset = BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === value)
                if (preset) setType(preset.type)
              }}
            >
              <Option value="">Custom filament</Option>
              {BAMBU_FILAMENT_PRESET_GROUPS.flatMap((group) => [
                <Typography
                  key={`brand-${group.brand}`}
                  level="body-xs"
                  textColor="text.tertiary"
                  sx={{ px: 1, pt: 0.75, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}
                >
                  {group.brand}
                </Typography>,
                ...group.presets.map((preset) => (
                  <Option key={preset.id} value={preset.id}>{preset.name}</Option>
                ))
              ])}
            </Select>
          </FormControl>
          {trayInfoIdx === '' && (
            <FormControl>
              <FormLabel>Type</FormLabel>
              <Select value={type} onChange={(_event, value) => { if (value) setType(value) }}>
                {FILAMENT_PRESETS.map((preset) => (
                  <Option key={preset.type} value={preset.type}>{preset.type}</Option>
                ))}
              </Select>
            </FormControl>
          )}
          <FormControl>
            <FormLabel>Color</FormLabel>
            <Input
              value={color}
              onChange={(event) => setColor(event.target.value)}
              startDecorator={
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    background: normalizedColor,
                    border: '1px solid rgba(255,255,255,0.25)'
                  }}
                />
              }
            />
            {colorName && (
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                Known color: {colorName}
              </Typography>
            )}
          </FormControl>
          {colorSwatches.length > 0 && (
            <ColorSwatchPicker
              title="Suggested colors"
              swatches={colorSwatches}
              selectedHex={normalizedColor}
              onPick={(hex) => setColor(hex)}
            />
          )}
          {error && <Alert color="danger" variant="soft">{error}</Alert>}
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button variant="plain" onClick={onClose}>Cancel</Button>
            <Button loading={saving} onClick={() => void save()}>Save</Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}
