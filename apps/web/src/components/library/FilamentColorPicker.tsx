/**
 * Filament colour control: a colour-swatch button that opens a modal with the brand-aware swatch grid
 * (e.g. "Bambu PLA Basic colors") plus a custom hex / colour-input option. Extracted from
 * `SliceSettingsPanel` so the 3D editor's slice settings AND the print-queue custom-material picker
 * share one control — the swatch family follows the chosen material exactly the same way in both.
 */
import { useState } from 'react'
import { Box, Button, DialogActions, FormControl, FormLabel, Input, ModalDialog, Sheet, Stack, Typography } from '@mui/joy'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { ColorSwatchPicker } from '../ColorSwatchPicker'
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  filamentTextColor,
  resolveFilamentColorSwatches,
  resolveProjectFilamentColorName
} from '../../lib/filamentColor'
import { bambuMaterialFromPresetName, bambuMaterialFromType } from '../../data/bambuColors'
import { normalizeSliceFilamentColor } from '../../lib/sliceProfileMatching'

export function FilamentColorPicker({
  color,
  material,
  materialType,
  brand,
  fullWidth = false,
  onChange
}: {
  color: string
  /** Specific material / preset name (e.g. "PLA Basic"), used to pick the Bambu colour family. */
  material: string
  /** Material type (e.g. "PLA"), used to derive the Bambu family when `material` is a profile name. */
  materialType: string
  brand: string
  fullWidth?: boolean
  onChange: (color: string) => void
}) {
  const [colorDialogOpen, setColorDialogOpen] = useState(false)
  const [customColorOpen, setCustomColorOpen] = useState(false)
  const [draftColor, setDraftColor] = useState(() => normalizeSliceFilamentColor(color).toUpperCase())
  const normalizedColor = normalizeSliceFilamentColor(color).toUpperCase()
  // The colour NAME resolves through the shared project resolver — it derives the Bambu family from
  // the type, so it works for a loaded preset whose brand is "Bambu Lab" (not exactly "Bambu") and
  // whose `material` is a full profile name. Falls back to the hex only when truly unknown.
  const filamentName = [brand, material].filter(Boolean).join(' ') || null
  const colorName = resolveProjectFilamentColorName({ color: normalizedColor, filamentName, filamentType: materialType })
  // Clean Bambu material name for the swatch grid + its title (e.g. "PLA Basic" from a profile name).
  const bambuMaterial = bambuMaterialFromPresetName(material) ?? bambuMaterialFromType(materialType)
  const { swatches, usesCommonFallback } = bambuMaterial
    ? resolveFilamentColorSwatches(bambuMaterial, { presetBrand: 'Bambu' })
    : { swatches: COMMON_FILAMENT_COLOR_SWATCHES, usesCommonFallback: true }
  const colorSwatches = bambuMaterial && !usesCommonFallback ? swatches : COMMON_FILAMENT_COLOR_SWATCHES
  const normalizedDraftColor = normalizeSliceFilamentColor(draftColor).toUpperCase()
  const draftColorName = resolveProjectFilamentColorName({ color: normalizedDraftColor, filamentName, filamentType: materialType })
  const openColorDialog = () => {
    setDraftColor(normalizedColor)
    setCustomColorOpen(false)
    setColorDialogOpen(true)
  }
  const applyCustomColor = () => {
    onChange(draftColor)
    setColorDialogOpen(false)
  }
  return (
    <>
      <Box
        component="button"
        type="button"
        onClick={openColorDialog}
        title={`Color: ${colorName ?? normalizedColor}`}
        aria-label={`Color ${colorName ?? normalizedColor}`}
        sx={{
          appearance: 'none',
          width: fullWidth ? '100%' : 36,
          height: 'var(--Input-minHeight, 2.25rem)',
          px: fullWidth ? 1 : 0,
          py: 0,
          borderRadius: 'sm',
          border: (theme) => `1px solid ${theme.vars.palette.divider}`,
          background: normalizedColor,
          color: filamentTextColor(null, normalizedColor),
          cursor: 'pointer',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: fullWidth ? 'flex-start' : 'center',
          overflow: 'hidden',
          transition: 'transform 80ms ease, border-color 80ms ease',
          '&:hover': { transform: 'scale(1.04)', borderColor: 'primary.outlinedBorder' },
          '&:focus-visible': {
            outline: (theme) => `2px solid ${theme.vars.palette.focusVisible}`,
            outlineOffset: 2
          }
        }}
      >
        {fullWidth && (
          <Typography level="body-xs" fontWeight="md" noWrap sx={{ color: 'inherit' }}>
            {colorName ?? normalizedColor}
          </Typography>
        )}
      </Box>
      <Modal open={colorDialogOpen} onClose={() => setColorDialogOpen(false)}>
        <ModalDialog sx={{ maxWidth: 520, width: '100%' }}>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Box sx={{ width: 56, height: 56, borderRadius: 'sm', background: normalizedDraftColor, border: '1px solid', borderColor: 'divider', flexShrink: 0 }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography level="h4">{draftColorName ?? normalizedDraftColor}</Typography>
              <Typography level="body-sm" textColor="text.tertiary">{[brand, material].filter(Boolean).join(' ') || 'Filament color'}</Typography>
            </Box>
          </Stack>
          <Stack spacing={1.25}>
            <ColorSwatchPicker
              title={bambuMaterial && !usesCommonFallback ? `Bambu ${bambuMaterial} colors` : 'Common filament colors'}
              swatches={colorSwatches}
              selectedHex={normalizedDraftColor}
              onPick={(nextColor) => setDraftColor(normalizeSliceFilamentColor(nextColor).toUpperCase())}
              onCustomPick={() => setCustomColorOpen(true)}
            />
            {customColorOpen && (
              <Sheet variant="soft" sx={{ p: 1, borderRadius: 'sm' }}>
                <Stack spacing={1}>
                  <Typography level="title-sm">Custom color</Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    <FormControl sx={{ flex: 0 }}>
                      <FormLabel>Color</FormLabel>
                      <Input
                        type="color"
                        value={normalizeSliceFilamentColor(draftColor)}
                        onChange={(event) => setDraftColor(normalizeSliceFilamentColor(event.target.value).toUpperCase())}
                        slotProps={{ input: { 'aria-label': 'Color' } }}
                        sx={{ width: 72, p: 0.5 }}
                      />
                    </FormControl>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Hex</FormLabel>
                      <Input
                        value={draftColor}
                        onChange={(event) => setDraftColor(normalizeSliceFilamentColor(event.target.value).toUpperCase())}
                        placeholder="#RRGGBB"
                      />
                    </FormControl>
                  </Stack>
                </Stack>
              </Sheet>
            )}
          </Stack>
          <DialogActions sx={{ pt: 1 }}>
            <Button type="button" variant="plain" onClick={() => setColorDialogOpen(false)}>Cancel</Button>
            <Button type="button" onClick={applyCustomColor}>Apply</Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  )
}
