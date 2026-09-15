/**
 * Maps retained source colours onto project filaments before a model enters the editor.
 *
 * The source stays immutable: changing the cluster count or gamma option re-runs the shared
 * quantizer, while Apply returns only the palette assignment. The caller owns material creation
 * and paint authoring so cancelling this dialog cannot partially change the project.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormLabel,
  Option,
  Select,
  Slider,
  Stack,
  Typography
} from '@mui/joy'
import {
  quantizeTriangleCornerColors,
  smoothQuantizedTextureColors,
  type ImportedMesh
} from '@printstream/shared/three-mf'
import { FormDialog } from '../../components/FormDialog'
import type { FilamentOption } from '../../components/library/PlateGcodeSections'
import { usePersistentState } from '../../hooks/usePersistentState'
import { SourceColorPreview } from './SourceColorPreview'
import {
  APPEND_SOURCE_COLOR,
  matchSourceColorsToFilaments,
  OBJ_IMPORT_GAMMA_PREFERENCE_KEY,
  recommendedSourceColorCount,
  sanitizeObjImportGammaPreference,
  sourceColorHex,
  type SourceColorImportChoice,
  type SourceColorMapping
} from './lib/sourceColorImport'

interface SourceColorImportDialogProps {
  name: string
  sourceColors: Float32Array
  mesh: Pick<ImportedMesh, 'positions' | 'indices'>
  sourceColorMode: 'vertex' | 'material' | 'texture'
  gammaCorrectable: boolean
  filaments: FilamentOption[]
  canAppend: boolean
  onCancel: () => void
  onSkip: () => void
  onApply: (choice: SourceColorImportChoice) => void
}

export function SourceColorImportDialog({
  name,
  sourceColors,
  mesh,
  sourceColorMode,
  gammaCorrectable,
  filaments,
  canAppend,
  onCancel,
  onSkip,
  onApply
}: SourceColorImportDialogProps) {
  const recommended = useMemo(() => recommendedSourceColorCount(sourceColors), [sourceColors])
  const [count, setCount] = useState(recommended)
  const [draftCount, setDraftCount] = useState(recommended)
  const [autoCount, setAutoCount] = useState(true)
  const [smoothLevel, setSmoothLevel] = useState(5)
  const [draftSmoothLevel, setDraftSmoothLevel] = useState(5)
  const [gammaCorrect, setGammaCorrect] = usePersistentState(
    OBJ_IMPORT_GAMMA_PREFERENCE_KEY,
    false,
    sanitizeObjImportGammaPreference
  )
  const clustered = useMemo(
    () => quantizeTriangleCornerColors(sourceColors, count, {
      gammaCorrect: gammaCorrectable && gammaCorrect
    }),
    [sourceColors, count, gammaCorrectable, gammaCorrect]
  )
  const quantized = useMemo(
    () => sourceColorMode === 'texture'
      ? smoothQuantizedTextureColors(mesh, clustered, smoothLevel)
      : clustered,
    [clustered, mesh, smoothLevel, sourceColorMode]
  )
  const matched = useMemo(() => matchSourceColorsToFilaments(quantized, filaments), [quantized, filaments])
  const [mappings, setMappings] = useState<SourceColorMapping[]>(matched)

  useEffect(() => { setMappings(matched) }, [matched])

  const setMapping = (index: number, value: SourceColorMapping | null) => {
    if (value == null) return
    setMappings((current) => current.map((entry, at) => at === index ? value : entry))
  }

  return (
    <FormDialog
      title={`Import colours from ${name}`}
      description="Turn the model's source colours into filament painting. Choose how many colours to retain, then map each result to a project filament."
      submitLabel="Apply colours"
      submitDisabled={filaments.length === 0 || quantized.clusters.length === 0 || mappings.length !== quantized.clusters.length}
      onClose={onCancel}
      onSubmit={() => onApply({ quantized, mappings })}
      secondaryActions={<Button variant="plain" color="neutral" onClick={onSkip}>Skip matching</Button>}
      width="min(900px, 100%)"
    >
      {sourceColorMode === 'texture' ? (
        <SourceColorPreview mesh={mesh} sourceColors={sourceColors} quantized={quantized} />
      ) : null}

      <FormControl>
        <FormLabel>Number of colours: {draftCount} ({recommended} recommended)</FormLabel>
        {sourceColorMode === 'texture' ? (
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            {[4, 8, 16].map((preset) => (
              <Button
                key={preset}
                size="sm"
                variant={!autoCount && count === preset ? 'soft' : 'outlined'}
                color={!autoCount && count === preset ? 'primary' : 'neutral'}
                onClick={() => {
                  setAutoCount(false)
                  setCount(preset)
                  setDraftCount(preset)
                }}
              >
                {preset}
              </Button>
            ))}
            <Button
              size="sm"
              variant={autoCount ? 'soft' : 'outlined'}
              color={autoCount ? 'primary' : 'neutral'}
              onClick={() => {
                setAutoCount(true)
                setCount(recommended)
                setDraftCount(recommended)
              }}
            >
              Recommended
            </Button>
          </Stack>
        ) : null}
        <Slider
          min={1}
          max={32}
          step={1}
          value={draftCount}
          valueLabelDisplay="auto"
          onChange={(_event, value) => setDraftCount(Array.isArray(value) ? value[0]! : value)}
          onChangeCommitted={(_event, value) => {
            setAutoCount(false)
            setCount(Array.isArray(value) ? value[0]! : value)
          }}
        />
      </FormControl>

      {sourceColorMode === 'texture' ? (
        <FormControl>
          <FormLabel>Smooth level: {draftSmoothLevel}</FormLabel>
          <Slider
            min={0}
            max={10}
            step={1}
            value={draftSmoothLevel}
            valueLabelDisplay="auto"
            onChange={(_event, value) => setDraftSmoothLevel(Array.isArray(value) ? value[0]! : value)}
            onChangeCommitted={(_event, value) => setSmoothLevel(Array.isArray(value) ? value[0]! : value)}
          />
          <Typography level="body-xs" textColor="text.tertiary">
            Higher values remove more isolated colour facets while preserving the model geometry.
          </Typography>
        </FormControl>
      ) : null}

      {gammaCorrectable ? (
        <Checkbox
          label="Gamma-correct source colours"
          checked={gammaCorrect}
          onChange={(event) => setGammaCorrect(event.target.checked)}
        />
      ) : null}

      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button size="sm" variant="outlined" color="neutral" onClick={() => setMappings(matched)}>
          Color match
        </Button>
        {canAppend ? (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => setMappings(quantized.clusters.map(() => APPEND_SOURCE_COLOR))}
          >
            Append as new filaments
          </Button>
        ) : null}
        <Button size="sm" variant="plain" color="neutral" onClick={() => setMappings(matched)}>
          Reset
        </Button>
      </Stack>

      <Stack spacing={1}>
        {quantized.clusters.map((cluster, index) => (
          <Stack
            key={`${index}-${cluster.color.join(',')}`}
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            alignItems={{ xs: 'stretch', sm: 'center' }}
          >
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 180 }}>
              <Box
                aria-label={`Source colour ${index + 1}`}
                sx={{ width: 24, height: 24, borderRadius: 'sm', border: '1px solid', borderColor: 'divider', bgcolor: sourceColorHex(cluster.color) }}
              />
              <Typography level="body-sm">Source colour {index + 1}</Typography>
              <Typography level="body-xs" textColor="text.tertiary">{Math.round(cluster.count / Math.max(1, sourceColors.length / 4) * 100)}%</Typography>
            </Stack>
            <Select<SourceColorMapping>
              size="sm"
              value={mappings[index] ?? matched[index] ?? filaments[0]?.id ?? 1}
              onChange={(_event, value) => setMapping(index, value)}
              sx={{ flex: 1 }}
            >
              {filaments.map((filament) => (
                <Option key={filament.id} value={filament.id}>
                  <Box component="span" sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: filament.color ?? '#808080', mr: 1, flex: '0 0 auto' }} />
                  {filament.number}. {filament.label}{filament.colorName ? `, ${filament.colorName}` : ''}
                </Option>
              ))}
              {canAppend ? <Option value={APPEND_SOURCE_COLOR}>Append a matching filament</Option> : null}
            </Select>
          </Stack>
        ))}
      </Stack>
    </FormDialog>
  )
}
