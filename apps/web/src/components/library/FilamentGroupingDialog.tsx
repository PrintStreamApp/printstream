/**
 * Two-nozzle filament grouping for the slice settings surface.
 *
 * Profile resolution happens only while the dialog is open. Automatic modes feed the shared
 * solver; Custom mode edits the same assignment map directly, so every path persists through the
 * existing material-to-toolhead contract used by save and slice.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, CircularProgress, DialogActions, Stack, Typography
} from '@mui/joy'
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded'
import {
  filamentPrintableOnExtruder,
  solveFilamentGrouping,
  type FilamentGroupingMode,
  type ProcessConfig
} from '@printstream/shared'
import { BackAwareModal } from '../BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import type { FilamentConfigResolver } from './FilamentSettingsDialog'

export interface GroupingFilament {
  id: number
  label: string
  color: string
  profileId: string | null
  projectFilamentId: number
  loadedToolheadId: string | null
  supportOnly: boolean
  overrides: Record<string, string | string[]>
}

export interface GroupingToolhead {
  id: string
  label: string
  /** Position in Bambu's slicer extruder arrays, not the runtime nozzle id encoded in `id`. */
  printableBitIndex: number
  nozzleFlow: 'standard' | 'high' | 'tpu-high'
  extruderType: 'direct' | 'bowden'
  preferSupport: boolean
}

type GroupingChoice = FilamentGroupingMode | 'custom'

interface FilamentGroupingDialogProps {
  open: boolean
  filaments: GroupingFilament[]
  toolheads: [GroupingToolhead, GroupingToolhead]
  initialAssignments: Record<number, string>
  flushVolumes: number[][] | null
  slicerTargetId: string
  sourceFileId: string
  resolveConfig: FilamentConfigResolver | undefined
  qualityAvailable: boolean
  matchAvailable: boolean
  dynamicMapping: boolean
  onClose: () => void
  onApply: (assignments: Record<number, string>, dynamicMapping: boolean) => void
}

/** Resolves profile constraints and offers automatic or manual two-nozzle grouping. */
export function FilamentGroupingDialog({
  open,
  filaments,
  toolheads,
  initialAssignments,
  flushVolumes,
  slicerTargetId,
  sourceFileId,
  resolveConfig,
  qualityAvailable,
  matchAvailable,
  dynamicMapping,
  onClose,
  onApply
}: FilamentGroupingDialogProps): JSX.Element {
  const [mode, setMode] = useState<GroupingChoice>('saving')
  const [assignments, setAssignments] = useState<Record<number, string>>(initialAssignments)
  const [smartAssign, setSmartAssign] = useState(dynamicMapping)
  const [configs, setConfigs] = useState<Record<number, ProcessConfig | null>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    if (!resolveConfig) {
      setConfigs(Object.fromEntries(filaments.map((filament) => [filament.id, null])))
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false

    /** Resolve every profile as one operation so loading, failure, and cancellation stay atomic. */
    const loadConfigs = async () => {
      setLoading(true)
      setError(null)

      try {
        const resolved = await resolveGroupingFilamentConfigs({
          filaments,
          resolveConfig,
          slicerTargetId,
          sourceFileId
        })

        if (!cancelled) {
          setConfigs(resolved)
        }
      } catch (cause: unknown) {
        if (!cancelled) {
          const message = cause instanceof Error
            ? cause.message
            : 'Could not resolve filament compatibility.'
          setError(message)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadConfigs()

    return () => {
      cancelled = true
    }
  }, [filaments, open, resolveConfig, slicerTargetId, sourceFileId])

  const automatic = useMemo(() => {
    if (mode === 'custom' || loading || error) {
      return null
    }

    return solveFilamentGrouping({
      mode,
      toolheadIds: [toolheads[0].id, toolheads[1].id],
      filaments: filaments.map((filament) => ({
        id: filament.id,
        compatibleToolheadIds: toolheads
          .filter((toolhead) => compatibleWithToolhead(configs[filament.id], toolhead))
          .map((toolhead) => toolhead.id),
        loadedToolheadId: filament.loadedToolheadId,
        qualityPenaltyByToolheadId: Object.fromEntries(toolheads.map((toolhead) => [
          toolhead.id,
          toolhead.preferSupport === filament.supportOnly ? 0 : 100
        ]))
      })),
      flushVolumes
    })
  }, [configs, error, filaments, flushVolumes, loading, mode, toolheads])

  const displayedAssignments = mode === 'custom' ? assignments : automatic?.assignments ?? assignments
  const hasUnassignedFilament = filaments.some((filament) => !displayedAssignments[filament.id])
  const automaticModeFailed = mode !== 'custom' && !automatic
  const invalid = hasUnassignedFilament || automaticModeFailed

  const selectMode = (next: GroupingChoice) => {
    if (next === 'custom') {
      setAssignments(displayedAssignments)
    }

    setMode(next)
  }

  const move = (filamentId: number, toolheadId: string) => {
    const config = configs[filamentId]
    const toolhead = toolheads.find((candidate) => candidate.id === toolheadId)

    if (!toolhead || !compatibleWithToolhead(config, toolhead)) {
      return
    }

    setAssignments((current) => ({ ...current, [filamentId]: toolheadId }))
  }

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ width: '100%', maxWidth: 720 }}>
        <Typography level="h4">Filament grouping</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, px: 0 }}>
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75}>
              <ModeButton
                selected={mode === 'saving'}
                onClick={() => selectMode('saving')}
                label="Filament saving"
                detail="Minimize flushing"
              />
              {matchAvailable && (
                <ModeButton
                  selected={mode === 'match'}
                  onClick={() => selectMode('match')}
                  label="Convenience"
                  detail="Keep loaded sides"
                />
              )}
              {qualityAvailable && (
                <ModeButton
                  selected={mode === 'quality'}
                  onClick={() => selectMode('quality')}
                  label="Quality"
                  detail="Prefer nozzle fit"
                />
              )}
              <ModeButton
                selected={mode === 'custom'}
                onClick={() => selectMode('custom')}
                label="Custom"
                detail="Assign manually"
              />
            </Stack>

            {loading && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size="sm" />
                <Typography level="body-sm">Checking filament profiles…</Typography>
              </Stack>
            )}
            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}
            {!loading && !error && mode !== 'custom' && !automatic && (
              <Alert color="danger" variant="soft">At least one material is not printable on either selected nozzle.</Alert>
            )}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              {toolheads.map((toolhead) => (
                <Box
                  key={toolhead.id}
                  sx={{
                    flex: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 'sm',
                    p: 1
                  }}
                >
                  <Typography level="title-sm" sx={{ mb: 0.75 }}>{toolhead.label}</Typography>
                  <Stack spacing={0.5}>
                    {filaments.filter((filament) => displayedAssignments[filament.id] === toolhead.id).map((filament) => {
                      const other = toolheads.find((candidate) => candidate.id !== toolhead.id)!
                      const canMove = mode === 'custom' && compatibleWithToolhead(configs[filament.id], other)
                      return (
                        <Button
                          key={filament.id}
                          type="button"
                          size="sm"
                          variant="soft"
                          color="neutral"
                          disabled={!canMove}
                          onClick={() => move(filament.id, other.id)}
                          startDecorator={(
                            <Box
                              sx={{
                                width: 13,
                                height: 13,
                                borderRadius: '50%',
                                bgcolor: filament.color,
                                border: '1px solid',
                                borderColor: 'divider'
                              }}
                            />
                          )}
                          endDecorator={canMove ? <SwapHorizRoundedIcon /> : undefined}
                          sx={{ justifyContent: 'flex-start' }}
                        >
                          {filament.label}
                        </Button>
                      )
                    })}
                    {!filaments.some((filament) => displayedAssignments[filament.id] === toolhead.id) && (
                      <Typography level="body-xs" textColor="text.tertiary">No materials</Typography>
                    )}
                  </Stack>
                </Box>
              ))}
            </Stack>

            <Checkbox
              checked={smartAssign}
              onChange={(event) => setSmartAssign(event.target.checked)}
              label="Enable smart filament assignment"
            />
            {automatic && (
              <Typography level="body-xs" textColor="text.tertiary">
                {describeAutomaticGrouping(automatic, mode)}
              </Typography>
            )}
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button type="button" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            disabled={loading || Boolean(error) || invalid}
            onClick={() => onApply(displayedAssignments, smartAssign)}
          >
            Apply
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

/** Summarizes whether the solver searched exhaustively and the impact of Convenience mode. */
function describeAutomaticGrouping(
  result: NonNullable<ReturnType<typeof solveFilamentGrouping>>,
  mode: GroupingChoice
): string {
  const searchDescription = result.exhaustive
    ? 'All valid groupings checked.'
    : 'Large project optimized with a bounded search.'

  if (mode !== 'match') {
    return searchDescription
  }

  const materialNoun = result.movedCount === 1 ? 'material' : 'materials'
  return `${searchDescription} ${result.movedCount} loaded ${materialNoun} would change sides.`
}

interface ModeButtonProps {
  selected: boolean
  onClick: () => void
  label: string
  detail: string
}

/** One strategy selector with a concise explanation of its optimization goal. */
function ModeButton({ selected, onClick, label, detail }: ModeButtonProps) {
  return (
    <Button
      type="button"
      variant={selected ? 'solid' : 'soft'}
      color={selected ? 'primary' : 'neutral'}
      onClick={onClick}
      sx={{ flex: 1 }}
    >
      <Stack>
        <span>{label}</span>
        <Typography level="body-xs" textColor="inherit">{detail}</Typography>
      </Stack>
    </Button>
  )
}

/**
 * Resolve and merge the effective config for each physical project filament.
 *
 * A filament without a profile deliberately resolves to `null`. The compatibility check treats
 * that as unknown and permits both sides, so an incomplete profile catalog does not invent a hard
 * restriction the slicer never reported.
 */
async function resolveGroupingFilamentConfigs({
  filaments,
  resolveConfig,
  slicerTargetId,
  sourceFileId
}: {
  filaments: GroupingFilament[]
  resolveConfig: FilamentConfigResolver
  slicerTargetId: string
  sourceFileId: string
}): Promise<Record<number, ProcessConfig | null>> {
  const entries = await Promise.all(filaments.map(async (filament) => {
    if (!filament.profileId) {
      return [filament.id, null] as const
    }

    const response = await resolveConfig({
      filamentProfileId: filament.profileId,
      targetId: slicerTargetId || null,
      sourceFileId,
      projectFilamentId: filament.projectFilamentId
    })

    return [filament.id, { ...response.config, ...filament.overrides }] as const
  }))

  return Object.fromEntries(entries)
}

/**
 * Whether one effective filament profile permits one concrete toolhead.
 *
 * `filament_printable` uses slicer-extruder position, while the saved assignment uses a runtime
 * nozzle id. `GroupingToolhead` carries both meanings separately so this function never converts
 * between them implicitly. Unknown profile data remains permissive; explicit masks and recognized
 * Bambu variant names are hard constraints.
 */
function compatibleWithToolhead(
  config: ProcessConfig | null | undefined,
  toolhead: GroupingToolhead
): boolean {
  if (!config) {
    return true
  }

  const printable = filamentPrintableOnExtruder(
    config.filament_printable,
    toolhead.printableBitIndex
  )
  if (!printable) {
    return false
  }

  const rawVariants = Array.isArray(config.filament_extruder_variant)
    ? config.filament_extruder_variant
    : [config.filament_extruder_variant]
  const variants = rawVariants
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.toLowerCase())

  const recognizable = variants.some(isRecognizedExtruderVariant)

  if (!recognizable) {
    return true
  }

  return variants.some((variant) => {
    return variantMatchesExtruderType(variant, toolhead.extruderType)
      && variantMatchesNozzleFlow(variant, toolhead.nozzleFlow)
  })
}

/** Whether a profile variant uses a Bambu name this client knows how to compare safely. */
function isRecognizedExtruderVariant(variant: string): boolean {
  return variant.includes('standard') || variant.includes('high flow')
}

/** Match the feed mechanism named by a Bambu filament variant. */
function variantMatchesExtruderType(variant: string, extruderType: GroupingToolhead['extruderType']): boolean {
  if (extruderType === 'bowden') {
    return variant.includes('bowden')
  }

  return variant.includes('direct drive')
}

/** Match standard, high-flow, and TPU high-flow variants without conflating their substrings. */
function variantMatchesNozzleFlow(variant: string, nozzleFlow: GroupingToolhead['nozzleFlow']): boolean {
  if (nozzleFlow === 'standard') {
    return variant.includes('standard') && !variant.includes('high flow')
  }

  if (nozzleFlow === 'tpu-high') {
    return variant.includes('tpu') && variant.includes('high flow')
  }

  return !variant.includes('tpu') && variant.includes('high flow')
}
