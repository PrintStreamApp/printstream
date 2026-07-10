/**
 * Read-only slice usage estimates (print time, prepare time, material weight/length,
 * cost) plus an optional per-material breakdown, rendered from a slicing job's result
 * `metadata`. Shared by the library "Slice results" dialog and the calibration
 * slice-then-print tracker so both surfaces present a finished slice identically.
 *
 * Renders the "no usage estimates" fallback line when the slicer reported nothing, so
 * callers can drop it in unconditionally once the job is ready.
 */
import { Box, Stack, Typography } from '@mui/joy'
import type { SlicingFilamentMapping, SlicingMetadata } from '@printstream/shared'
import { formatSecondsDuration } from '../../lib/time'

export function SliceEstimates({
  metadata,
  filamentMappings
}: {
  metadata: SlicingMetadata
  /** Slice request material choices, used to name/colour the per-material rows. */
  filamentMappings?: SlicingFilamentMapping[]
}) {
  const stats: Array<{ label: string; value: string }> = []
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
    stats.push({ label: 'Estimated cost', value: `$${metadata.estimatedFilamentCost.toFixed(2)}` })
  }

  if (stats.length === 0) {
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
    materialInfoById.set(mapping.projectFilamentId, { name: mapping.material ?? null, color: mapping.color ?? null })
  }
  const materials = metadata?.materials ?? []

  return (
    <Stack spacing={1}>
      <Stack spacing={0.5}>
        {stats.map((stat) => (
          <Stack key={stat.label} direction="row" justifyContent="space-between" spacing={2}>
            <Typography level="body-sm" textColor="text.tertiary">{stat.label}</Typography>
            <Typography level="body-sm" fontWeight="md">{stat.value}</Typography>
          </Stack>
        ))}
      </Stack>
      {materials.length > 1 && (
        <Stack spacing={0.5}>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>Per material</Typography>
          {materials.map((material, index) => {
            const info = material.id != null ? materialInfoById.get(material.id) : undefined
            const color = info?.color || material.color || null
            const name = info?.name || material.type || `Material ${material.id ?? index + 1}`
            return (
              <Stack key={material.id ?? index} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                  <Box sx={{ width: 14, height: 14, borderRadius: '3px', flexShrink: 0, bgcolor: color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
                  <Typography level="body-sm" textColor="text.tertiary" noWrap>{name}</Typography>
                </Stack>
                <Typography level="body-sm" fontWeight="md">{material.weightGrams != null ? `${material.weightGrams.toFixed(1)} g` : '—'}</Typography>
              </Stack>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}
