/**
 * One required filament's material picker for the queue dialog. The dropdown offers the sliced
 * **file default**, the **nearest-matching** Filament-library materials (with remaining quantity),
 * a **Browse all materials…** entry that opens the searchable {@link MaterialPickerDialog}, and a
 * one-off **Custom** material. The custom row is brand + type + colour: the brand field is a freeSolo
 * Autocomplete seeded with the slicer's real filament **brands** (e.g. "Bambu Lab") — a convenient
 * starting point, but any brand can be typed; the type dropdown picks the material; and the colour
 * reuses the editor's {@link FilamentColorPicker} (brand-aware swatch family + custom colour). All default
 * to the sliced brand + type + colour. The selected mode is tracked explicitly — picking "Custom" sticks
 * even when its values equal the file default. The chosen type+colour drive the queue matcher (brand is
 * display-only, like a library material); a type that differs from what the file was sliced for warns but
 * is allowed.
 */
import { useEffect, useMemo, useState } from 'react'
import { Autocomplete, Box, FormControl, FormLabel, Option, Select, Stack, Typography } from '@mui/joy'
import { normalizeHexColor, type QueueRequiredFilament } from '@printstream/shared'
import { FilamentOptionLabel } from '../../components/library/FilamentOptionLabel'
import { FilamentColorPicker } from '../../components/library/FilamentColorPicker'
import { COMMON_FILAMENT_TYPES } from '../../lib/filamentColor'
import { MaterialPickerDialog } from './MaterialPickerDialog'
import { materialKey, suggestMaterials, type LibraryMaterial } from './useFilamentLibrary'
import { useFilamentBrands } from './useFilamentBrands'

export function QueueMaterialRow({
  file,
  value,
  materials,
  requiredGrams,
  onChange
}: {
  /** The sliced file's filament on this plate (the "file default" + compatibility reference). */
  file: QueueRequiredFilament
  value: QueueRequiredFilament
  materials: LibraryMaterial[]
  /** Grams this filament needs on the plate — drives the remaining "enough?" indicator. */
  requiredGrams?: number
  onChange: (next: QueueRequiredFilament) => void
}) {
  // Explicit "user picked Custom" flag — the real fix for Custom doing nothing. Reset when the
  // underlying sliced filament changes (e.g. a plate change re-seeds the row to the file default).
  const [forceCustom, setForceCustom] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const brands = useFilamentBrands()
  useEffect(() => {
    setForceCustom(false)
  }, [file.id, file.filamentType, file.color])

  const fileKey = materialKey(file.filamentType, file.color)
  const currentKey = materialKey(value.filamentType, value.color)
  const matchesFile = currentKey === fileKey
  const libMatch = materials.find((material) => material.key === currentKey)
  const mode: 'file' | 'lib' | 'custom' = forceCustom ? 'custom' : matchesFile ? 'file' : libMatch ? 'lib' : 'custom'
  const selectValue = mode === 'lib' && libMatch ? `lib:${libMatch.key}` : mode
  const isCustom = mode === 'custom'

  // The gcode is sliced for the file's type; a different type may print badly — warn (not block).
  const fileType = (file.filamentType ?? '').trim()
  const currentType = (value.filamentType ?? '').trim()
  const typeMismatch = fileType !== '' && currentType !== '' && currentType.toLowerCase() !== fileType.toLowerCase()
  const typeMissing = currentType === ''
  const warn = typeMismatch || typeMissing
  const mismatchText = `Sliced for ${file.filamentType} — a different material type may not print correctly.`
  // Tooltip for the trailing warning glyph on the selected value (mirrors the slot picker's glyph).
  const selectedWarningLabel = typeMismatch ? mismatchText : typeMissing ? 'Choose a material type so the queue can match a printer.' : null
  // Warn on a suggestion whose type differs from what the file was sliced for.
  const suggestionWarningLabel = (materialType: string): string | null =>
    fileType !== '' && materialType.trim() !== '' && materialType.trim().toLowerCase() !== fileType.toLowerCase() ? mismatchText : null

  // Nearest compatible materials to suggest inline; always include the current pick if it's a
  // library material so re-opening an item shows its selection even when it's not a top suggestion.
  const suggestions = useMemo(() => suggestMaterials(materials, file.filamentType, file.color, 5), [materials, file.filamentType, file.color])
  const suggestionList = libMatch && !suggestions.some((s) => s.key === libMatch.key) ? [libMatch, ...suggestions] : suggestions

  // Constrained custom-material type list: the known common types, plus the current value when it's
  // a preset (e.g. "PLA Basic") that isn't in the list, so the sliced default stays selectable.
  const typeOptions = useMemo(() => {
    const current = (value.filamentType ?? '').trim()
    const options = COMMON_FILAMENT_TYPES.map((type) => type as string)
    return current && !options.some((type) => type.toLowerCase() === current.toLowerCase()) ? [current, ...options] : options
  }, [value.filamentType])
  const customHex = normalizeHexColor(value.color) ?? '#888888'

  const applyMaterial = (material: LibraryMaterial) => {
    setForceCustom(false)
    onChange({ id: file.id, filamentType: material.filamentType, color: material.color, filamentName: material.brand })
  }

  const select = (next: string | null) => {
    if (next === 'file') {
      setForceCustom(false)
      return onChange({ id: file.id, filamentType: file.filamentType, color: file.color, filamentName: file.filamentName })
    }
    if (next === 'custom') {
      // Seed a one-off custom from the sliced file's brand + type + colour; all are editable below.
      // Brand is display-only (the matcher routes on type + colour).
      setForceCustom(true)
      return onChange({ id: file.id, filamentType: file.filamentType, color: file.color, filamentName: file.filamentName })
    }
    if (next === 'browse') return setBrowseOpen(true)
    const material = materials.find((entry) => `lib:${entry.key}` === next)
    if (material) applyMaterial(material)
  }

  return (
    <Stack spacing={0.5}>
      {requiredGrams != null ? (
        <Typography level="body-xs" textColor="text.tertiary" sx={{ alignSelf: 'flex-end' }}>
          Needs ~{Math.round(requiredGrams)}g
        </Typography>
      ) : null}
      <Select
        size="sm"
        value={selectValue}
        color={warn ? 'warning' : 'neutral'}
        onChange={(_event, next) => select(next)}
        renderValue={() => (
          <FilamentOptionLabel
            color={value.color}
            filamentType={value.filamentType}
            filamentName={value.filamentName}
            remainingGrams={libMatch?.remainingGrams}
            remainPercent={libMatch?.remainPercent}
            requiredGrams={requiredGrams}
            aggregated={(libMatch?.spoolCount ?? 0) > 1}
            warningLabel={selectedWarningLabel}
          />
        )}
        slotProps={{ button: { sx: { minHeight: 40, textAlign: 'left', justifyContent: 'flex-start' } }, listbox: { sx: { maxHeight: '45vh' } } }}
      >
        <Option value="file">
          <FilamentOptionLabel color={file.color} filamentType={file.filamentType} filamentName={file.filamentName} secondary="File default" />
        </Option>

        {suggestionList.length > 0 ? (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, pt: 0.75, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Suggested from library
          </Typography>
        ) : null}
        {suggestionList.map((material) => (
          <Option key={material.key} value={`lib:${material.key}`}>
            <FilamentOptionLabel
              color={material.color}
              filamentType={material.filamentType}
              filamentName={material.brand}
              remainingGrams={material.remainingGrams}
              remainPercent={material.remainPercent}
              requiredGrams={requiredGrams}
              aggregated={material.spoolCount > 1}
              warningLabel={suggestionWarningLabel(material.filamentType)}
            />
          </Option>
        ))}
        {materials.length > 0 ? <Option value="browse">Browse all materials…</Option> : null}

        <Option value="custom">Custom material…</Option>
      </Select>

      {isCustom ? (
        <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ pl: 0.5 }}>
          <FormControl sx={{ flex: 1, minWidth: 0 }}>
            <FormLabel>Brand</FormLabel>
            <Autocomplete<string, false, false, true>
              size="sm"
              freeSolo
              openOnFocus
              selectOnFocus
              handleHomeEndKeys
              placeholder="e.g. Bambu Lab (optional)"
              options={brands}
              inputValue={value.filamentName ?? ''}
              onInputChange={(_event, next, reason) => {
                // 'reset' fires when an option is picked (and on blur) — only react to actual typing / clear.
                if (reason === 'reset') return
                onChange({ ...value, id: file.id, filamentName: next.trim() === '' ? null : next })
              }}
              onChange={(_event, picked) => {
                if (picked == null) return
                onChange({ ...value, id: file.id, filamentName: picked.trim() === '' ? null : picked })
              }}
              slotProps={{ listbox: { sx: { maxHeight: 300 } } }}
            />
          </FormControl>
          <FormControl sx={{ flex: 1, minWidth: 0 }}>
            <FormLabel>Type</FormLabel>
            <Select
              size="sm"
              value={(value.filamentType ?? '') || null}
              placeholder="Choose a type…"
              onChange={(_event, next) => next && onChange({ ...value, id: file.id, filamentType: next })}
            >
              {typeOptions.map((type) => <Option key={type} value={type}>{type}</Option>)}
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel>Colour</FormLabel>
            {/* Reuses the 3D editor's colour control: a swatch button opening a modal with the
                brand-aware swatch family (from the type) + a custom hex / colour-input option. */}
            <FilamentColorPicker
              color={customHex}
              material={value.filamentType ?? ''}
              materialType={value.filamentType ?? ''}
              brand={value.filamentName ?? ''}
              onChange={(hex) => onChange({ ...value, id: file.id, color: hex })}
            />
          </FormControl>
        </Stack>
      ) : null}

      {warn ? (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ pl: 0.5 }}>
          {/* Inline SVG (Joy-themed) rather than an @mui/icons-material icon — a Material icon with
              `sx` reaches for the Material theme's breakpoints, which a Joy-only app doesn't carry. */}
          <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: 16, height: 16, display: 'block', fill: 'currentColor', color: 'warning.plainColor', flexShrink: 0 }}>
            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
          </Box>
          <Typography level="body-xs" color="warning">
            {typeMismatch
              ? `Sliced for ${file.filamentType}. A different material type may not print correctly.`
              : 'Choose a material type so the queue can match a printer.'}
          </Typography>
        </Stack>
      ) : null}

      {browseOpen ? (
        <MaterialPickerDialog
          open
          onClose={() => setBrowseOpen(false)}
          onPick={applyMaterial}
          materials={materials}
          filamentType={file.filamentType}
          color={file.color}
          requiredGrams={requiredGrams}
        />
      ) : null}
    </Stack>
  )
}
