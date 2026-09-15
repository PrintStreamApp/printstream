/**
 * Focused editor for the rectangular bed geometry stored by a machine preset.
 *
 * BambuStudio's Create Printer form currently exposes only this rectangular shape. The preset wire
 * format remains in `@printstream/shared`; this component owns transient form state and makes a
 * non-rectangular source explicit before replacing it with its bounds.
 */
import { useState } from 'react'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded'
import { Alert, Box, Button, Chip, FormControl, FormHelperText, FormLabel, Input, Stack, Typography } from '@mui/joy'
import {
  applyRectangularMachineBuildVolume,
  clearPortableMachineBedAsset,
  MAX_CUSTOM_PRINTER_HEIGHT_MM,
  readPortableMachineBedAsset,
  readRectangularMachineBuildVolume,
  setPortableMachineBedAsset,
  validateRectangularMachineBuildVolume,
  type PortableMachineBedAssetKind,
  type ProcessConfig,
  type RectangularMachineBuildVolume
} from '@printstream/shared'
import { FormDialog } from '../FormDialog'

export function MachineBuildVolumeDialog({
  config,
  allowAssetEditing = false,
  onClose,
  onApply
}: {
  config: ProcessConfig
  /** Bed assets belong to stored presets, never project/slice override maps. */
  allowAssetEditing?: boolean
  onClose: () => void
  onApply: (config: ProcessConfig) => void
}): JSX.Element {
  const initial = readRectangularMachineBuildVolume(config)
  const [fields, setFields] = useState(() => volumeToFields(initial.volume))
  const [assetConfig, setAssetConfig] = useState(config)
  const [error, setError] = useState<string | null>(null)
  const volume = fieldsToVolume(fields)

  const update = (key: keyof BuildVolumeFields, value: string): void => {
    setFields((current) => ({ ...current, [key]: value }))
    setError(null)
  }

  const submit = (): void => {
    const problem = validateRectangularMachineBuildVolume(volume)
    if (problem) {
      setError(problem)
      return
    }
    try {
      onApply(applyRectangularMachineBuildVolume(assetConfig, volume))
      onClose()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to update the build volume.')
    }
  }

  return (
    <FormDialog
      onClose={onClose}
      title="Bed and build volume"
      description="Set the rectangular printable bed and the machine's maximum print height. The origin is the distance from the front-left corner to G-code position 0,0."
      error={error}
      submitLabel="Apply"
      onSubmit={submit}
      width="min(680px, 100%)"
    >
      {!initial.exactRectangle && (
        <Alert color="warning" variant="soft">
          This preset does not contain a rectangular printable area. Applying these values replaces
          its current shape with the rectangular bounds shown here.
        </Alert>
      )}

      <BedOriginPreview volume={volume} />

      <Box sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(3, minmax(0, 1fr))' },
        gap: 1.5
      }}>
        <MeasurementField
          label="Bed width (X)"
          value={fields.width}
          min={0}
          helper="Greater than 0 mm"
          onChange={(value) => update('width', value)}
        />
        <MeasurementField
          label="Bed depth (Y)"
          value={fields.depth}
          min={0}
          helper="Greater than 0 mm"
          onChange={(value) => update('depth', value)}
        />
        <MeasurementField
          label="Printable height (Z)"
          value={fields.height}
          min={0}
          max={MAX_CUSTOM_PRINTER_HEIGHT_MM}
          helper={`Greater than 0, up to ${MAX_CUSTOM_PRINTER_HEIGHT_MM} mm`}
          onChange={(value) => update('height', value)}
        />
      </Box>

      <Box sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
        gap: 1.5
      }}>
        <MeasurementField
          label="X origin from front-left"
          value={fields.originX}
          helper="May be outside the bed"
          onChange={(value) => update('originX', value)}
        />
        <MeasurementField
          label="Y origin from front-left"
          value={fields.originY}
          helper="May be outside the bed"
          onChange={(value) => update('originY', value)}
        />
      </Box>

      {allowAssetEditing && (<>
        <Typography level="title-sm">Custom bed appearance</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <BedAssetField
            kind="model"
            config={assetConfig}
            onChange={setAssetConfig}
            onError={setError}
          />
          <BedAssetField
            kind="texture"
            config={assetConfig}
            onChange={setAssetConfig}
            onError={setError}
          />
        </Stack>
      </>)}
    </FormDialog>
  )
}

function BedAssetField({
  kind,
  config,
  onChange,
  onError
}: {
  kind: PortableMachineBedAssetKind
  config: ProcessConfig
  onChange: (config: ProcessConfig) => void
  onError: (message: string | null) => void
}): JSX.Element {
  const embedded = readPortableMachineBedAsset(config, kind)
  const pathValue = config[kind === 'model' ? 'bed_custom_model' : 'bed_custom_texture']
  const existingPath = typeof pathValue === 'string' && pathValue.trim() ? pathValue : null
  const label = kind === 'model' ? 'Bed model' : 'Bed texture'
  const accept = kind === 'model' ? '.stl' : '.png,.svg'

  const pick = async (file: File): Promise<void> => {
    onError(null)
    try {
      onChange(setPortableMachineBedAsset(config, kind, {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer())
      }))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : `The ${label.toLowerCase()} could not be added.`)
    }
  }

  return (
    <FormControl sx={{ flex: 1 }}>
      <FormLabel>{label}</FormLabel>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button component="label" size="sm" variant="soft" startDecorator={<UploadFileRoundedIcon />}>
          {embedded || existingPath ? 'Replace' : 'Choose file'}
          <input
            hidden
            type="file"
            accept={accept}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void pick(file)
              event.target.value = ''
            }}
          />
        </Button>
        {existingPath && (
          <Button
            size="sm"
            variant="plain"
            color="danger"
            startDecorator={<DeleteOutlineRoundedIcon />}
            onClick={() => onChange(clearPortableMachineBedAsset(config, kind))}
          >
            Remove
          </Button>
        )}
      </Stack>
      {existingPath && (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75, minWidth: 0 }}>
          <Typography level="body-xs" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {embedded?.name ?? existingPath}
          </Typography>
          {!embedded && (
            <Chip size="sm" variant="soft" color="warning">
              Local path only
            </Chip>
          )}
        </Stack>
      )}
      <FormHelperText>{kind === 'model' ? 'STL, up to 1 MB' : 'PNG or SVG, up to 1 MB'}</FormHelperText>
    </FormControl>
  )
}

interface BuildVolumeFields {
  width: string
  depth: string
  originX: string
  originY: string
  height: string
}

function volumeToFields(volume: RectangularMachineBuildVolume): BuildVolumeFields {
  return {
    width: String(volume.width),
    depth: String(volume.depth),
    originX: String(volume.originX),
    originY: String(volume.originY),
    height: String(volume.height)
  }
}

function fieldsToVolume(fields: BuildVolumeFields): RectangularMachineBuildVolume {
  return {
    width: fields.width.trim() === '' ? Number.NaN : Number(fields.width),
    depth: fields.depth.trim() === '' ? Number.NaN : Number(fields.depth),
    originX: fields.originX.trim() === '' ? Number.NaN : Number(fields.originX),
    originY: fields.originY.trim() === '' ? Number.NaN : Number(fields.originY),
    height: fields.height.trim() === '' ? Number.NaN : Number(fields.height)
  }
}

function MeasurementField({
  label,
  value,
  min,
  max,
  helper,
  onChange
}: {
  label: string
  value: string
  min?: number
  max?: number
  helper: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <FormControl sx={{ minWidth: 0 }}>
      <FormLabel>{label}</FormLabel>
      <Input
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        endDecorator="mm"
        slotProps={{ input: { min, max, step: 'any' } }}
        sx={{ width: '100%', minWidth: 0 }}
      />
      <FormHelperText>{helper}</FormHelperText>
    </FormControl>
  )
}

/** A small orientation aid, not a dimensional drawing: fields remain the source of exact values. */
function BedOriginPreview({ volume }: { volume: RectangularMachineBuildVolume }): JSX.Element {
  const validBed = Number.isFinite(volume.width) && volume.width > 0
    && Number.isFinite(volume.depth) && volume.depth > 0
  const originLeft = validBed ? (volume.originX / volume.width) * 100 : 0
  const originTop = validBed ? 100 - (volume.originY / volume.depth) * 100 : 100
  const originVisible = originLeft >= 0 && originLeft <= 100 && originTop >= 0 && originTop <= 100

  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <Box
        sx={{
          position: 'relative',
          width: 128,
          aspectRatio: validBed ? `${volume.width} / ${volume.depth}` : '1',
          maxHeight: 128,
          border: '2px solid',
          borderColor: 'neutral.outlinedBorder',
          borderRadius: 'sm',
          bgcolor: 'background.level1',
          flexShrink: 0
        }}
        aria-hidden="true"
      >
        {originVisible && (
          <Box
            sx={{
              position: 'absolute',
              left: `${originLeft}%`,
              top: `${originTop}%`,
              width: 10,
              height: 10,
              borderRadius: '50%',
              bgcolor: 'primary.solidBg',
              transform: 'translate(-50%, -50%)',
              boxShadow: '0 0 0 2px var(--joy-palette-background-surface)'
            }}
          />
        )}
      </Box>
      <Stack spacing={0.25}>
        <Typography level="title-sm">Front-left bed reference</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          The marker shows G-code 0,0 when it falls within the printable rectangle.
        </Typography>
      </Stack>
    </Stack>
  )
}
