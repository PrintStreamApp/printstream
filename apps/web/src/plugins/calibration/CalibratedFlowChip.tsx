/**
 * Calibration contribution for a slice-dialog material row. It resolves every saved filament
 * calibration for the selected material, contributes the applicable values as ephemeral slice
 * settings, and labels the row so the automatic changes are visible before slicing.
 */
import { useEffect, useMemo, useState } from 'react'
import { Dropdown, IconButton, ListItemDecorator, ListSubheader, Menu, MenuButton, MenuItem, Tooltip } from '@mui/joy'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import { useQuery } from '@tanstack/react-query'
import {
  resolveBestCalibrationValue,
  resolveTargetedCalibrationValue,
  calibrationMatchesPrinter,
  PRESSURE_ADVANCE_MODE_SETTING,
  type CalibrationFilamentIdentity,
  type CalibrationResult
} from '@printstream/shared'
import { calibrationKeys, fetchCalibrationResults } from './api'
import { calibrationKindLabel } from './runPresentation'

const SOURCE = 'calibration'

function finiteProjectFilamentId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

const APPLIED_SETTINGS: Partial<Record<CalibrationResult['kind'], (value: number) => Record<string, string>>> = {
  pressureAdvance: (value) => ({ enable_pressure_advance: '1', pressure_advance: String(value) }),
  flowRatio: (value) => ({ filament_flow_ratio: String(value) }),
  temperature: (value) => ({ nozzle_temperature: String(value), nozzle_temperature_initial_layer: String(value) }),
  maxVolumetricSpeed: (value) => ({ filament_max_volumetric_speed: String(value) }),
  retraction: (value) => ({ filament_retraction_length: String(value) })
}

const LABELS: Record<CalibrationResult['kind'], (value: number) => string> = {
  pressureAdvance: (value) => value.toFixed(4),
  flowRatio: (value) => value.toFixed(3),
  temperature: (value) => `${Math.round(value)} C`,
  maxVolumetricSpeed: (value) => `${value.toFixed(1)} mm3/s`,
  vfa: (value) => `VFA ${Math.round(value)} mm/s`,
  retraction: (value) => `retraction ${value.toFixed(1)} mm`
}

/** Render and apply saved calibrations matching one selected slice material. */
export function CalibratedFlowChip(props: Record<string, unknown>) {
  // This is an operation-local choice, never a change to the saved calibration.
  const [disabledKinds, setDisabledKinds] = useState<CalibrationResult['kind'][]>([])
  const [selectedIds, setSelectedIds] = useState<Partial<Record<CalibrationResult['kind'], string>>>({})
  const projectFilamentId = finiteProjectFilamentId(props.projectFilamentId)
  const printerModel = typeof props.printerModel === 'string' ? props.printerModel : null
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  const nozzleDiameter = typeof props.nozzleDiameter === 'string' ? props.nozzleDiameter : null
  const filament = props.filament && typeof props.filament === 'object'
    ? props.filament as CalibrationFilamentIdentity
    : null
  const onSettingsChange = typeof props.onSettingsChange === 'function'
    ? props.onSettingsChange as (
      projectFilamentId: number,
      source: string,
      overrides: Record<string, string | string[]> | null
    ) => void
    : null
  const explicitSettings = props.explicitSettings && typeof props.explicitSettings === 'object'
    ? props.explicitSettings as Record<string, string | string[]>
    : {}
  const ready = projectFilamentId != null && Boolean(printerModel && nozzleDiameter && filament)
  const resultsQuery = useQuery({
    queryKey: calibrationKeys.results,
    queryFn: ({ signal }) => fetchCalibrationResults(signal),
    enabled: ready,
    staleTime: 30_000
  })
  const results = useMemo(() => {
    if (!ready || !filament) return []
    const targetResults = resultsQuery.data ?? []
    return (['pressureAdvance', 'flowRatio', 'temperature', 'maxVolumetricSpeed', 'vfa', 'retraction'] as const)
      .map((kind) => resolveTargetedCalibrationValue<CalibrationResult>(
        targetResults.filter((candidate) => candidate.kind === kind),
        filament,
        { printerId, printerModel: printerModel!, nozzleDiameter: nozzleDiameter! }
      ))
      .filter((result): result is CalibrationResult => result != null && APPLIED_SETTINGS[result.kind] != null)
  }, [filament, nozzleDiameter, printerId, printerModel, ready, resultsQuery.data])

  const candidates = (resultsQuery.data ?? []).filter((candidate) =>
    filament && printerModel && nozzleDiameter && calibrationMatchesPrinter(candidate, { printerId, printerModel, nozzleDiameter })
    && resolveBestCalibrationValue([candidate], filament) != null)
  const selectedResults = results.map((recommended) =>
    candidates.find((candidate) => candidate.kind === recommended.kind && candidate.id === selectedIds[recommended.kind]) ?? recommended)

  // Depend on the effective settings, not recreated slot-context objects, so a parent
  // render cannot repeatedly remove and reapply the contribution.
  const overridesJson = JSON.stringify(Object.assign({}, ...selectedResults
      .filter((result) => !disabledKinds.includes(result.kind))
      .map((result) => ({
        ...APPLIED_SETTINGS[result.kind]?.(result.value),
        ...(result.kind === 'pressureAdvance' ? { [PRESSURE_ADVANCE_MODE_SETTING]: result.pressureAdvanceMode ?? 'native' } : {})
      }))))
  useEffect(() => {
    if (projectFilamentId == null || !onSettingsChange) return
    const overrides = JSON.parse(overridesJson) as Record<string, string>
    onSettingsChange(projectFilamentId, SOURCE, Object.keys(overrides).length > 0 ? overrides : null)
    return () => onSettingsChange(projectFilamentId, SOURCE, null)
  }, [onSettingsChange, projectFilamentId, overridesJson])

  if (candidates.length === 0) return null
  const enabledCount = results.filter((result) => !disabledKinds.includes(result.kind)).length
  const useSavedCalibration = enabledCount > 0
  const appliedKeys = results.flatMap((result) => Object.keys(APPLIED_SETTINGS[result.kind]?.(result.value) ?? {}))
  const explicitlyOverridden = appliedKeys.some((key) => Object.prototype.hasOwnProperty.call(explicitSettings, key))
  {
    return (
      <Dropdown>
        <Tooltip title={`${enabledCount} of ${results.length} saved calibrations on. Choose which to use.${explicitlyOverridden ? ' Your manual settings take priority.' : ''}`}>
          <MenuButton
            slots={{ root: IconButton }}
            slotProps={{ root: { size: 'sm', variant: useSavedCalibration ? 'soft' : 'plain', color: useSavedCalibration ? 'success' : 'neutral' } }}
            aria-label={`Saved calibrations for material ${projectFilamentId}: ${enabledCount} of ${results.length} on`}
          >
            <ScienceRoundedIcon fontSize="small" />
          </MenuButton>
        </Tooltip>
        <Menu size="sm" aria-label="Use saved calibrations" sx={{
          maxHeight: 'min(420px, 70dvh)',
          maxWidth: 'min(400px, 90vw)',
          overflowY: 'auto',
          // Match directory dropdowns: portalled menus must sit above their parent modal.
          zIndex: (theme) => theme.zIndex.tooltip
        }}>
          {[...new Set(candidates.map((result) => result.kind))].map((kind) => {
            const supported = APPLIED_SETTINGS[kind] != null
            const selected = selectedResults.find((result) => result.kind === kind)
            return <div key={kind} role="group" aria-label={calibrationKindLabel(kind)}>
              <ListSubheader>{calibrationKindLabel(kind)}</ListSubheader>
              {!supported ? <MenuItem disabled>Reference speed: set this in Process settings.</MenuItem> : null}
              <MenuItem
                role="menuitemradio"
                aria-checked={!supported || disabledKinds.includes(kind)}
                disabled={!supported}
                onClick={() => setDisabledKinds((current) => [...new Set([...current, kind])])}
              >
                <ListItemDecorator>
                  {!supported || disabledKinds.includes(kind) ? <CheckRoundedIcon fontSize="small" /> : null}
                </ListItemDecorator>
                Do not override
              </MenuItem>
              {candidates.filter((result) => result.kind === kind).map((result) => (
                <MenuItem key={result.id} disabled={!supported} role="menuitemradio" aria-checked={supported && !disabledKinds.includes(kind) && selected?.id === result.id} onClick={() => {
                  setSelectedIds((current) => ({ ...current, [kind]: result.id }))
                  setDisabledKinds((current) => current.filter((value) => value !== kind))
                }}>
                  <ListItemDecorator>{supported && !disabledKinds.includes(kind) && selected?.id === result.id ? <CheckRoundedIcon fontSize="small" /> : null}</ListItemDecorator>
                  {LABELS[kind](result.value)}{kind === 'pressureAdvance' ? ` (${result.pressureAdvanceMode === 'linear' ? 'Linear' : 'Native'})` : ''} · {result.scope === 'spool' ? 'This spool' : [result.brand, result.filamentType, result.materialSubtype, result.colorName].filter(Boolean).join(' · ')}
                  {' · '}{result.printerTarget?.scope === 'printers' ? 'Printer-specific' : result.printerTarget?.models.join(', ') ?? result.printerModel}
                </MenuItem>
              ))}
            </div>
          })}
        </Menu>
      </Dropdown>
    )
  }
}
