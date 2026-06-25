/**
 * Create / edit form for a filament spool. Used from the Filament view's "Add
 * spool" button and each row's Edit action. Submits to the create or update
 * endpoint via the shared mutations; closes on success.
 *
 * Brand / Material / Variant / Vendor are chevron-style free-text autocompletes:
 * the workspace's own previously-used values are grouped under "Used before"
 * above curated suggestions, so past entries are one click away. The colour uses
 * the same preset swatch grid as the AMS slot editor and is combination-aware —
 * a known brand + material (e.g. Bambu PLA Basic) shows that family's palette,
 * otherwise the common colours.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Autocomplete, Box, Button, DialogActions, DialogTitle, FormControl, FormLabel, Input, Stack, Textarea, Typography
} from '@mui/joy'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import { extractErrorMessage, type FilamentSpool, type SpoolCreateInput } from '@printstream/shared'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { ColorSwatchPicker } from '../../components/ColorSwatchPicker'
import { COMMON_FILAMENT_COLOR_SWATCHES, commonFilamentColorName, resolveFilamentColorSwatches } from '../../lib/filamentColor'
import { bambuColorName, bambuMaterialFromPresetName, bambuMaterialFromType } from '../../data/bambuColors'
import { useSpoolMutations, useSpoolsQuery } from './api'
import { FILAMENT_BRAND_SUGGESTIONS, FILAMENT_MATERIAL_SUGGESTIONS, FILAMENT_VARIANT_SUGGESTIONS } from './constants'

type FormState = {
  brand: string
  filamentType: string
  materialSubtype: string
  colorHex: string
  netWeightGrams: string
  remainingGrams: string
  vendor: string
  costDollars: string
  notes: string
}

type FieldOption = { label: string; group: string }

function initialState(spool: FilamentSpool | null): FormState {
  return {
    brand: spool?.brand ?? '',
    filamentType: spool?.filamentType ?? '',
    materialSubtype: spool?.materialSubtype ?? '',
    colorHex: spool?.colorHex ?? '#888888',
    netWeightGrams: String(spool?.netWeightGrams ?? 1000),
    remainingGrams: spool ? String(Math.round(spool.remainingGrams)) : '1000',
    vendor: spool?.vendor ?? '',
    costDollars: spool?.costCents != null ? (spool.costCents / 100).toFixed(2) : '',
    notes: spool?.notes ?? ''
  }
}

/** Distinct, trimmed, case-insensitively de-duped and sorted (keeps first casing). */
function distinct(values: Array<string | null | undefined>): string[] {
  const byKey = new Map<string, string>()
  for (const value of values) {
    const trimmed = (value ?? '').trim()
    if (trimmed && !byKey.has(trimmed.toLowerCase())) byKey.set(trimmed.toLowerCase(), trimmed)
  }
  return [...byKey.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
}

/** Build grouped options: the user's past values first, then unused suggestions. */
function buildOptions(used: string[], suggestions: readonly string[]): FieldOption[] {
  const usedValues = distinct(used)
  const usedKeys = new Set(usedValues.map((value) => value.toLowerCase()))
  const suggestionValues = distinct([...suggestions]).filter((value) => !usedKeys.has(value.toLowerCase()))
  return [
    ...usedValues.map((label) => ({ label, group: 'Used before' })),
    ...suggestionValues.map((label) => ({ label, group: 'Suggestions' }))
  ]
}

/**
 * A chevron-style free-text autocomplete: the dropdown opens from the chevron,
 * shows the grouped options, and any typed value is kept.
 */
function FieldAutocomplete({
  options,
  value,
  onChange,
  placeholder
}: {
  options: FieldOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <Autocomplete
      freeSolo
      forcePopupIcon
      popupIcon={<ArrowDropDownIcon />}
      openOnFocus
      selectOnFocus
      handleHomeEndKeys
      options={options}
      groupBy={(option) => option.group}
      getOptionLabel={(option) => (typeof option === 'string' ? option : option.label)}
      inputValue={value}
      onInputChange={(_event, next) => onChange(next)}
      onChange={(_event, next) => { if (next != null) onChange(typeof next === 'string' ? next : next.label) }}
      placeholder={placeholder}
      slotProps={{ listbox: { sx: { maxHeight: 300 } } }}
    />
  )
}

export function SpoolFormDialog({ open, spool, onClose }: { open: boolean; spool: FilamentSpool | null; onClose: () => void }) {
  const { create, update } = useSpoolMutations()
  const spoolsQuery = useSpoolsQuery()
  const [form, setForm] = useState<FormState>(() => initialState(spool))
  const [error, setError] = useState<string | null>(null)

  // Re-seed the form whenever the dialog opens for a different spool.
  useEffect(() => {
    if (open) {
      setForm(initialState(spool))
      setError(null)
    }
  }, [open, spool])

  const set = <K extends keyof FormState>(key: K) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }))

  const spools = useMemo(() => spoolsQuery.data ?? [], [spoolsQuery.data])
  const brandOptions = useMemo(() => buildOptions(spools.map((s) => s.brand ?? ''), FILAMENT_BRAND_SUGGESTIONS), [spools])
  const materialOptions = useMemo(() => buildOptions(spools.map((s) => s.filamentType), FILAMENT_MATERIAL_SUGGESTIONS), [spools])
  const variantOptions = useMemo(() => buildOptions(spools.map((s) => s.materialSubtype ?? ''), FILAMENT_VARIANT_SUGGESTIONS), [spools])
  const vendorOptions = useMemo(() => buildOptions(spools.map((s) => s.vendor ?? ''), []), [spools])

  const validColorHex = /^#[0-9A-Fa-f]{6}$/.test(form.colorHex) ? form.colorHex : '#888888'
  const normalizedColorHex = validColorHex.toUpperCase()

  // Combination-aware swatches: a known Bambu brand + material shows that
  // family's palette (e.g. Bambu PLA Basic); otherwise the common colours.
  const isBambuBrand = /\bbambu\b/i.test(form.brand)
  const bambuMaterialKey = isBambuBrand
    ? (bambuMaterialFromPresetName(form.materialSubtype || form.filamentType)
        ?? bambuMaterialFromType(form.materialSubtype || form.filamentType))
    : null
  const { swatches: colorSwatches, usesCommonFallback } = bambuMaterialKey
    ? resolveFilamentColorSwatches(bambuMaterialKey, { presetBrand: 'Bambu' })
    : { swatches: COMMON_FILAMENT_COLOR_SWATCHES, usesCommonFallback: true }
  const colorSwatchTitle = usesCommonFallback || !bambuMaterialKey
    ? 'Common filament colours'
    : `Bambu ${bambuMaterialKey} colours`
  const knownColorName = (bambuMaterialKey ? bambuColorName(normalizedColorHex, bambuMaterialKey) : null)
    ?? commonFilamentColorName(normalizedColorHex)

  const submit = async () => {
    setError(null)
    const filamentType = form.filamentType.trim()
    if (!filamentType) {
      setError('Material type is required (e.g. PLA).')
      return
    }
    const net = Number(form.netWeightGrams) || 1000
    const cost = form.costDollars.trim() ? Math.round(Number(form.costDollars) * 100) : null
    const payload: SpoolCreateInput = {
      filamentType,
      brand: form.brand.trim() || null,
      materialSubtype: form.materialSubtype.trim() || null,
      colorHex: /^#[0-9A-Fa-f]{6}$/.test(form.colorHex) ? form.colorHex : null,
      netWeightGrams: net,
      remainingGrams: form.remainingGrams.trim() ? Math.max(0, Number(form.remainingGrams)) : net,
      vendor: form.vendor.trim() || null,
      costCents: cost != null && !Number.isNaN(cost) ? cost : null,
      currency: cost != null && !Number.isNaN(cost) ? 'USD' : null,
      notes: form.notes.trim() || null
    }
    try {
      if (spool) await update.mutateAsync({ id: spool.id, input: payload })
      else await create.mutateAsync(payload)
      onClose()
    } catch (caught) {
      setError(extractErrorMessage(caught, 'Could not save the spool.'))
    }
  }

  const saving = create.isPending || update.isPending

  return (
    <Modal open={open} onClose={onClose}>
      <ScrollableModalDialog variant="outlined" sx={{ width: { xs: '100%', sm: 520 }, maxWidth: '100%' }}>
        <DialogTitle>{spool ? 'Edit spool' : 'Add spool'}</DialogTitle>
        <ScrollableDialogBody>
          <Stack spacing={1.25}>
            {error && <Alert color="danger" variant="soft">{error}</Alert>}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Brand</FormLabel>
                <FieldAutocomplete options={brandOptions} value={form.brand} onChange={set('brand')} placeholder="Bambu, Polymaker…" />
              </FormControl>
              <FormControl sx={{ flex: 1 }} required>
                <FormLabel>Material</FormLabel>
                <FieldAutocomplete options={materialOptions} value={form.filamentType} onChange={set('filamentType')} placeholder="PLA" />
              </FormControl>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Variant</FormLabel>
                <FieldAutocomplete options={variantOptions} value={form.materialSubtype} onChange={set('materialSubtype')} placeholder="PLA Silk, Matte…" />
              </FormControl>
              <FormControl>
                <FormLabel>Colour</FormLabel>
                <Input
                  type="color"
                  value={validColorHex}
                  onChange={(e) => set('colorHex')(e.target.value)}
                  sx={{ width: 64, p: 0.5 }}
                />
              </FormControl>
            </Stack>
            <Stack spacing={0.5}>
              <ColorSwatchPicker
                title={colorSwatchTitle}
                swatches={colorSwatches}
                selectedHex={normalizedColorHex}
                onPick={(hex) => set('colorHex')(hex)}
              />
              {knownColorName && (
                <Typography level="body-xs" textColor="text.tertiary">Known colour: {knownColorName}</Typography>
              )}
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Net weight (g)</FormLabel>
                <Input type="number" value={form.netWeightGrams} onChange={(e) => set('netWeightGrams')(e.target.value)} />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Remaining (g)</FormLabel>
                <Input type="number" value={form.remainingGrams} onChange={(e) => set('remainingGrams')(e.target.value)} />
              </FormControl>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Vendor</FormLabel>
                <FieldAutocomplete options={vendorOptions} value={form.vendor} onChange={set('vendor')} placeholder="Where you bought it" />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Cost</FormLabel>
                <Input type="number" startDecorator="$" value={form.costDollars} onChange={(e) => set('costDollars')(e.target.value)} />
              </FormControl>
            </Stack>
            <FormControl>
              <FormLabel>Notes</FormLabel>
              <Textarea minRows={2} value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
            </FormControl>
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button color="primary" loading={saving} onClick={() => void submit()}>{spool ? 'Save' : 'Add spool'}</Button>
          </Box>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}
