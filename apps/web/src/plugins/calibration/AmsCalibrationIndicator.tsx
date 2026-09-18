/**
 * Compact AMS-slot marker for a loaded filament with saved calibration data. The slot host supplies
 * its printer-reported identity; the core loaded-spool registry can refine that to a tracked spool
 * without this plugin importing filament-manager directly.
 */
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import { Box, Tooltip } from '@mui/joy'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  resolveTargetedCalibrationValue,
  type CalibrationFilamentIdentity,
  type CalibrationResult
} from '@printstream/shared'
import { useSlotFilamentIdentityLookup } from '../../lib/slotFilamentIdentity'
import { calibrationKeys, fetchCalibrationResults } from './api'
import { calibrationKindLabel, calibrationValueLabel } from './runPresentation'

/** Show a small flask on an AMS slot when at least one saved value resolves for its filament. */
export function AmsCalibrationIndicator(props: Record<string, unknown>) {
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  const printerModel = typeof props.printerModel === 'string' ? props.printerModel : null
  const amsId = typeof props.amsId === 'number' ? props.amsId : null
  const slotId = typeof props.slotId === 'number' ? props.slotId : null
  const fallback = useMemo(
    () => props.filament && typeof props.filament === 'object'
      ? props.filament as CalibrationFilamentIdentity
      : null,
    [props.filament]
  )
  const lookupLoadedSpool = useSlotFilamentIdentityLookup()
  const tracked = lookupLoadedSpool(printerId, amsId, slotId)
  const filament = useMemo<CalibrationFilamentIdentity | null>(() => tracked
    ? {
        spoolId: tracked.spoolId,
        brand: tracked.brand ?? fallback?.brand ?? null,
        filamentType: tracked.filamentType ?? fallback?.filamentType ?? null,
        materialSubtype: tracked.materialSubtype ?? fallback?.materialSubtype ?? null,
        colorName: tracked.colorName ?? fallback?.colorName ?? null
      }
    : fallback, [fallback, tracked])
  const query = useQuery({
    queryKey: calibrationKeys.results,
    queryFn: ({ signal }) => fetchCalibrationResults(signal),
    enabled: Boolean(printerModel && filament),
    staleTime: 30_000
  })
  const matches = useMemo(() => {
    if (!printerModel || !filament) return []
    const target = query.data ?? []
    const groups = new Map<string, CalibrationResult[]>()
    for (const result of target) {
      const key = `${result.kind}:${result.nozzleDiameter}`
      groups.set(key, [...(groups.get(key) ?? []), result])
    }
    return [...groups.values()]
      .map((candidates) => resolveTargetedCalibrationValue(candidates, filament, { printerId, printerModel, nozzleDiameter: candidates[0]!.nozzleDiameter }))
      .filter((result): result is CalibrationResult => result != null)
  }, [filament, printerId, printerModel, query.data])

  if (matches.length === 0) return null
  const details = matches
    .map((result) => `${calibrationKindLabel(result.kind)} ${calibrationValueLabel(result.kind, result.value)} (${result.nozzleDiameter} mm)`)
    .join(', ')
  return (
    <Tooltip title={`Saved calibration: ${details}`}>
      <Box
        component="span"
        aria-label={`${matches.length} saved ${matches.length === 1 ? 'calibration' : 'calibrations'}`}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 17,
          height: 17,
          borderRadius: '50%',
          color: 'var(--joy-palette-success-100)',
          backgroundColor: 'var(--joy-palette-success-700)',
          boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.35)',
          fontSize: 12
        }}
      >
        <ScienceRoundedIcon fontSize="inherit" />
      </Box>
    </Tooltip>
  )
}
