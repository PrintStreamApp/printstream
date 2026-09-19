/**
 * BambuStudio's height range modifiers for one object: Z bands that override process settings for
 * the layers inside them (`Metadata/layer_config_ranges.xml`).
 *
 * Presentational: the bands are handed in and edited through callbacks; the editor owns the state
 * and the emit. Z values are OBJECT space, mm, with z=0 at the object's underside, which is the
 * frame the file stores and the slicer reads, so the inputs are bounded by the object's own
 * height, not the plate's.
 *
 * Layer height is edited inline rather than behind the settings gear because every band must carry
 * one: BambuStudio's slicer reads `layer_height` off a range without checking the key exists and
 * null-derefs otherwise, so a band without it is not a band with a default, it is a crash. The
 * gear covers the rest of the per-object settings for that band.
 *
 * Unlike BambuStudio, overlapping bands cannot be created here. Studio lets them exist and silently
 * resolves them at slice time by trimming the lower band's top away, which means the plate does not
 * print what the UI showed.
 */
import { Alert, Button, IconButton, Input, Sheet, Stack, Typography } from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import LayersRoundedIcon from '@mui/icons-material/LayersRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { FormDialog } from '../../components/FormDialog'
import { EmptyState } from '../../components/EmptyState'
import type { EditorHeightRange } from './lib/editorModel'
import { moveBandEdge, nextBandSlot, sortBands } from './lib/heightRangeBands'


export interface HeightRangesDialogProps {
  objectName: string
  ranges: ReadonlyArray<EditorHeightRange>
  /** The object's printable height (mm). Bands are clamped to it, as BambuStudio clips them. */
  objectHeightMm: number | null
  /** The layer height a new band starts at, from the active process settings. */
  defaultLayerHeightMm: number
  /**
   * Whether the object also carries a variable layer height profile, which OVERRIDES these bands'
   * layer heights at slice time. Said out loud rather than left to surprise: the engine only falls
   * back to ranges when the profile is absent or invalid (`PrintObject.cpp:3340`).
   */
  hasLayerHeightProfile: boolean
  /** How many settings beyond `layer_height` a band overrides, for the gear's badge. */
  extraSettingCount: (range: EditorHeightRange) => number
  onChange: (ranges: EditorHeightRange[]) => void
  onEditSettings: (index: number) => void
  onClose: () => void
}

export function HeightRangesDialog({
  objectName, ranges, objectHeightMm, defaultLayerHeightMm, hasLayerHeightProfile, extraSettingCount,
  onChange, onEditSettings, onClose
}: HeightRangesDialogProps) {
  const bands = sortBands(ranges)
  const slot = nextBandSlot(bands, objectHeightMm)

  const moveEdge = (index: number, edge: 'minZ' | 'maxZ', value: number) => {
    const next = moveBandEdge(bands, index, edge, value, objectHeightMm)
    if (next) onChange(next)
  }

  const setLayerHeight = (index: number, value: number) => {
    if (!Number.isFinite(value) || value <= 0) return
    const next = bands.map((range) => ({ ...range, settings: { ...range.settings } }))
    const band = next[index]
    if (!band) return
    band.settings.layer_height = String(value)
    onChange(next)
  }

  const addBand = () => {
    if (!slot) return
    onChange([...bands, {
      minZ: slot.minZ,
      maxZ: slot.maxZ,
      // Never author a band without a layer height: BambuStudio crashes reading one back.
      settings: { layer_height: String(defaultLayerHeightMm), extruder: '0' }
    }])
  }

  const removeBand = (index: number) => onChange(bands.filter((_, i) => i !== index))

  return (
    <FormDialog
      title="Height ranges"
      description={
        objectHeightMm != null
          ? `Override settings for a band of ${objectName}, measured in mm from its base (it is ${objectHeightMm.toFixed(1)} mm tall).`
          : `Override settings for a band of ${objectName}, measured in mm from its base.`
      }
      submitLabel="Done"
      onSubmit={onClose}
      onClose={onClose}
      width="min(560px, 100%)"
    >
      <Stack spacing={1}>
        {hasLayerHeightProfile && (
          <Alert size="sm" color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
            <Typography level="body-xs">
              This model has a variable layer height profile, which <b>overrides</b> the layer
              height of every range below; their other settings still apply. Reset the profile in
              Variable layer height to hand layer height back to these ranges.
            </Typography>
          </Alert>
        )}
        {bands.length === 0 ? (
          <EmptyState
            icon={<LayersRoundedIcon />}
            title="No height ranges"
            description="Add a range to vary layer height or other settings."
          />
        ) : bands.map((band, index) => (
          <Sheet
            key={`${band.minZ}-${band.maxZ}-${index}`}
            variant="outlined"
            sx={{ p: 1, borderRadius: 'sm', display: 'flex', flexDirection: 'column', gap: 0.75 }}
          >
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <Input
                size="sm"
                type="number"
                value={Math.round(band.minZ * 100) / 100}
                onChange={(event) => moveEdge(index, 'minZ', Number.parseFloat(event.target.value))}
                startDecorator="From"
                endDecorator="mm"
                slotProps={{ input: { step: 0.1, min: 0, 'aria-label': `Range ${index + 1} start height` } }}
                sx={{ flex: '1 1 150px', minWidth: 0 }}
              />
              <Input
                size="sm"
                type="number"
                value={Math.round(band.maxZ * 100) / 100}
                onChange={(event) => moveEdge(index, 'maxZ', Number.parseFloat(event.target.value))}
                startDecorator="To"
                endDecorator="mm"
                slotProps={{ input: { step: 0.1, min: 0, 'aria-label': `Range ${index + 1} end height` } }}
                sx={{ flex: '1 1 150px', minWidth: 0 }}
              />
            </Stack>
            <Stack direction="row" spacing={0.75} alignItems="center">
              <Input
                size="sm"
                type="number"
                value={Number(band.settings.layer_height ?? defaultLayerHeightMm)}
                onChange={(event) => setLayerHeight(index, Number.parseFloat(event.target.value))}
                startDecorator="Layer"
                endDecorator="mm"
                slotProps={{ input: { step: 0.02, min: 0.02, 'aria-label': `Range ${index + 1} layer height` } }}
                sx={{ flex: 1, minWidth: 0 }}
              />
              <IconButton
                size="sm"
                variant="soft"
                color={extraSettingCount(band) > 0 ? 'primary' : 'neutral'}
                aria-label={`Other settings for range ${index + 1}`}
                title="Other settings for this range"
                onClick={() => onEditSettings(index)}
              >
                <TuneRoundedIcon />
              </IconButton>
              <IconButton
                size="sm"
                variant="plain"
                color="danger"
                aria-label={`Remove range ${index + 1}`}
                onClick={() => removeBand(index)}
              >
                <CloseRoundedIcon />
              </IconButton>
            </Stack>
          </Sheet>
        ))}
        <Stack direction="row" justifyContent="flex-start">
          <Button
            size="sm"
            variant="soft"
            startDecorator={<AddRoundedIcon />}
            disabled={!slot}
            title={slot ? undefined : 'No room left on this model for another range'}
            onClick={addBand}
          >
            Add range
          </Button>
        </Stack>
      </Stack>
    </FormDialog>
  )
}
