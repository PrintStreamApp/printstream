/**
 * Read-only slice usage estimates (print time, prepare time, material weight/length,
 * cost) plus optional per-material and per-plate breakdowns, rendered from a slicing
 * job's result `metadata`. A caller with a G-code preview can add per-plate actions.
 *
 * Renders the "no usage estimates" fallback line when the slicer reported nothing, so
 * callers can drop it in unconditionally once the job is ready.
 */
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import { Box, Button, Stack, Typography } from '@mui/joy'
import type { SlicingFilamentMapping, SlicingMaterialUsage, SlicingMetadata } from '@printstream/shared'
import { formatSecondsDuration } from '../../lib/time'
import { formatFilamentCost } from '../../lib/filamentCost'

export function SliceEstimates({
  metadata,
  filamentMappings,
  onPreviewPlate,
  onPrintPlate
}: {
  metadata: SlicingMetadata
  /** Slice request material choices, used to name/colour the per-material rows. */
  filamentMappings?: SlicingFilamentMapping[]
  onPreviewPlate?: (plateIndex: number) => void
  /** Open the print dialog with this plate selected. Omitted when printing is unavailable. */
  onPrintPlate?: (plateIndex: number) => void
}) {
  const stats: Array<{ label: string; value: string }> = []
  const plates = metadata?.plates ?? []
  if (metadata?.estimatedPrintTimeSeconds != null && metadata.estimatedPrintTimeSeconds >= 1) {
    stats.push({ label: 'Estimated print time', value: formatSecondsDuration(metadata.estimatedPrintTimeSeconds) })
  }
  if (metadata?.estimatedPrepareTimeSeconds != null && metadata.estimatedPrepareTimeSeconds >= 1) {
    stats.push({ label: 'Prepare time', value: formatSecondsDuration(metadata.estimatedPrepareTimeSeconds) })
  }
  if (metadata?.estimatedFilamentWeightGrams != null) {
    stats.push({ label: 'Material used', value: `${metadata.estimatedFilamentWeightGrams.toFixed(1)} g` })
  }
  if (metadata?.estimatedFilamentLengthMm != null) {
    stats.push({ label: 'Material length', value: `${(metadata.estimatedFilamentLengthMm / 1000).toFixed(2)} m` })
  }
  if (metadata?.estimatedFilamentCost != null) {
    stats.push({ label: 'Estimated cost', value: formatFilamentCost(metadata.estimatedFilamentCost) })
  }

  const materials = metadata?.materials ?? []
  if (stats.length === 0 && materials.length === 0 && plates.length === 0) {
    return (
      <Typography level="body-sm" textColor="text.secondary">
        Slicing finished. The slicer did not report usage estimates for this job.
      </Typography>
    )
  }

  // result.json reports per-material weight by filament id but no name/colour, so enrich
  // each row from the slice request's chosen material (keyed by projectFilamentId == id).
  const materialInfoById = new Map<number, { name: string | null; color: string | null }>()
  for (const mapping of filamentMappings ?? []) {
    materialInfoById.set(mapping.projectFilamentId, {
      name: mapping.material ?? mapping.materialType ?? null,
      color: mapping.color ?? null
    })
  }

  return (
    <Stack spacing={1}>
      {plates.length > 1 && (
        <Typography level="title-sm">All {plates.length} plates</Typography>
      )}
      <Stack spacing={0.5}>
        {stats.map((stat) => (
          <Stack key={stat.label} direction="row" justifyContent="space-between" spacing={2}>
            <Typography level="body-sm" textColor="text.tertiary">{stat.label}</Typography>
            <Typography level="body-sm" fontWeight="md">{stat.value}</Typography>
          </Stack>
        ))}
      </Stack>
      {materials.length > 0 && (
        <Stack spacing={0.5}>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>Per material</Typography>
          <MaterialUsageRows materials={materials} materialInfoById={materialInfoById} />
        </Stack>
      )}
      {plates.length > 1 && plates.map((plate) => (
        <Stack key={plate.index} spacing={0.25} sx={{ pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography level="title-sm">Plate {plate.index}</Typography>
            <Stack direction="row" spacing={0.75}>
              {onPreviewPlate && (
                <Button
                  type="button"
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  startDecorator={<VisibilityRoundedIcon />}
                  onClick={() => onPreviewPlate(plate.index)}
                >
                  Preview
                </Button>
              )}
              {onPrintPlate && (
                <Button
                  type="button"
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  startDecorator={<PrintRoundedIcon />}
                  onClick={() => onPrintPlate(plate.index)}
                >
                  Print
                </Button>
              )}
            </Stack>
          </Stack>
          {plate.estimatedPrintTimeSeconds != null && (
            <EstimateRow label="Estimated print time" value={formatSecondsDuration(plate.estimatedPrintTimeSeconds)} />
          )}
          {plate.estimatedFilamentWeightGrams != null && (
            <EstimateRow label="Material used" value={`${plate.estimatedFilamentWeightGrams.toFixed(1)} g`} />
          )}
          {plate.estimatedFilamentLengthMm != null && (
            <EstimateRow label="Material length" value={`${(plate.estimatedFilamentLengthMm / 1000).toFixed(2)} m`} />
          )}
          {plate.materials && plate.materials.length > 0 && (
            <MaterialUsageRows materials={plate.materials} materialInfoById={materialInfoById} />
          )}
        </Stack>
      ))}
    </Stack>
  )
}

/** The same material identity and usage presentation for whole-job and per-plate results. */
function MaterialUsageRows({
  materials,
  materialInfoById
}: {
  materials: SlicingMaterialUsage[]
  materialInfoById: Map<number, { name: string | null; color: string | null }>
}) {
  return materials.map((material, index) => {
    const info = material.id != null ? materialInfoById.get(material.id) : undefined
    const color = info?.color || material.color || null
    const name = info?.name || material.type || `Material ${material.id ?? index + 1}`
    return (
      <Stack key={material.id ?? index} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Box sx={{ width: 14, height: 14, borderRadius: '3px', flexShrink: 0, bgcolor: color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
          <Typography level="body-sm" textColor="text.tertiary" noWrap>{name}</Typography>
        </Stack>
        <Typography level="body-sm" fontWeight="md">
          {formatMaterialUsage(material.weightGrams, material.lengthMm)}
        </Typography>
      </Stack>
    )
  })
}

function EstimateRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography level="body-sm" textColor="text.tertiary">{label}</Typography>
      <Typography level="body-sm" fontWeight="md">{value}</Typography>
    </Stack>
  )
}

/** Format the weight and length the engine reported for one project material. */
function formatMaterialUsage(weightGrams?: number | null, lengthMm?: number | null): string {
  const values: string[] = []
  if (weightGrams != null) values.push(`${weightGrams.toFixed(1)} g`)
  if (lengthMm != null) values.push(`${(lengthMm / 1000).toFixed(2)} m`)
  return values.join(' · ') || '–'
}
