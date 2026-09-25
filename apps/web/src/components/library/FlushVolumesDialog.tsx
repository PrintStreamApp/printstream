/**
 * Edit how much filament is purged on each material change: BambuStudio's "Flushing volumes for
 * filament change" dialog, with its per-pair grid, per-extruder multiplier and re-calculation.
 *
 * WHY IT EXISTS. These volumes decide most of the waste on a multi-material print, and until now
 * nothing in the app could show or change them: a project with wrong purge volumes could only be
 * met as a bad print or, when the stored matrix contradicted the machine, as a failed slice. So
 * this is also where that defect is surfaced in context, rather than only as a banner on a file.
 *
 * WHAT "UNSET" MEANS. A project may legitimately carry NO matrix, that absence is what makes
 * BambuStudio compute one at slice time, so opening this dialog must not materialise a matrix.
 * Until the user edits or calculates, it shows the suggestion as a preview and saves nothing; the
 * moment they change a value, the whole grid becomes the project's own and is written on save.
 *
 * WHERE THE NUMBERS COME FROM. `suggestProjectFlushVolumes` is a port of Studio's own calculation,
 * verified against its compiled code AND against the engine's live answer; it prefers Studio's
 * MEASURED tables where they cover a colour pair and falls back to the colour formula elsewhere.
 * The tables are fetched from the slicer image, so an install with no slicer still calculates, one
 * fidelity step down, which is why the footnote names which of the two produced what is on screen,
 * and says so plainly when the engine itself disagrees with us (`evaluateFlushCalibration`).
 *
 * Counterpart: `SceneEdit.flushVolumes` and the bake's `applyFlushVolumes`, which checks the grid
 * against the material list it is actually writing (see that function for why it may drop it).
 */
import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  DialogActions,
  Divider,
  FormControl,
  FormLabel,
  Input,
  ModalClose,
  Option,
  Select,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  Typography
} from '@mui/joy'
import CalculateRoundedIcon from '@mui/icons-material/CalculateRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  FLUSH_MULTIPLIER_RANGE,
  availablePrimeVolumeModes,
  suggestProjectFlushVolumes,
  type FlushCalibrationVerdict,
  type PrimeVolumeMode,
  type ProjectFlushContext,
  type SceneEditFlushVolumes
} from '@printstream/shared'
import type { FlushDatasets } from '../../plugins/model-studio/lib/flushDatasets'
import { BackAwareModal } from '../BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { FlushVolumesGrid, type FlushGridFilament } from './FlushVolumesGrid'
import {
  FLUSH_PROVENANCE_NOTE,
  isPreviewingFlushVolumes,
  resolveFlushProvenance,
  seedFlushBlocks
} from '../../lib/flushVolumesModel'

export interface FlushVolumesDialogProps {
  open: boolean
  onClose: () => void
  /** Machine + stored values, read from the project's own settings. */
  context: ProjectFlushContext
  /** The SESSION's materials, which may differ from the project's if one was added or reordered. */
  filaments: FlushGridFilament[]
  /** Per-extruder labels (`Left`/`Right` on a dual-nozzle machine); one entry per extruder. */
  extruderLabels: string[]
  /** Measured tables from the slicer, or `{}` when none are available. */
  datasets: FlushDatasets
  /**
   * Whether the engine's own computed matrix agreed with ours, or null when it was never checked
   * (no slicer to ask). Only ever changes the footnote, a disagreement is a fidelity caveat, not a
   * reason to withhold the editor.
   */
  calibration: FlushCalibrationVerdict | null
  /** The session's edit, if the user has already made one. */
  value: SceneEditFlushVolumes | null
  onApply: (next: SceneEditFlushVolumes) => void
  /** Offered when the stored matrix contradicts the project's topology. */
  onRepair?: () => void
}

export function FlushVolumesDialog({
  open,
  onClose,
  context,
  filaments,
  extruderLabels,
  datasets,
  calibration,
  value,
  onApply,
  onRepair
}: FlushVolumesDialogProps): JSX.Element {
  // What BambuStudio's "Re-calculate" would produce, per extruder, for the SESSION's materials:
  // through the shared composer, so the dialog cannot pair "read the project" with "calculate"
  // differently from the calibration check that verifies the pairing against the real engine.
  const suggestionBlocks = useMemo(
    () => suggestProjectFlushVolumes({ context, colors: filaments.map((filament) => filament.color), datasets }),
    [context, filaments, datasets]
  )
  const suggestion = useMemo(
    () => (extruderIndex: number) => suggestionBlocks[extruderIndex] ?? [],
    [suggestionBlocks]
  )

  const [blocks, setBlocks] = useState<number[][][]>(
    () => value?.matrix?.map((block) => block.map((row) => [...row]))
      ?? seedFlushBlocks({ context, filamentCount: filaments.length, suggestion })
  )
  const availableModes = useMemo(() => availablePrimeVolumeModes(context), [context])
  const [primeVolumeMode, setPrimeVolumeMode] = useState<PrimeVolumeMode>(() => {
    const initial = value?.primeVolumeMode ?? context.primeVolumeMode
    return availableModes.includes(initial) ? initial : 'Default'
  })
  const [multipliers, setMultipliers] = useState<Record<'normal' | 'fast', number[]>>(() => {
    const initial = {
      normal: [...context.multipliers.normal],
      fast: [...context.multipliers.fast]
    }

    if (value) {
      const valueSet = multiplierSetFor(value.primeVolumeMode ?? context.primeVolumeMode)
      initial[valueSet] = [...value.multiplier]
    }

    return initial
  })
  const activeMultiplierSet = multiplierSetFor(primeVolumeMode)
  const multiplier = multipliers[activeMultiplierSet]
  // A project with no stored matrix is showing a PREVIEW, not its own values, until the user acts.
  const [matrixTouched, setMatrixTouched] = useState(value?.matrix != null)
  const [settingsTouched, setSettingsTouched] = useState(value !== null)
  const [extruderTab, setExtruderTab] = useState(0)

  const previewing = isPreviewingFlushVolumes({ context, touched: matrixTouched })
  const dirty = matrixTouched || settingsTouched

  const setCell = (extruderIndex: number, fromIndex: number, toIndex: number, next: number) => {
    setMatrixTouched(true)
    setBlocks((current) => updateFlushCell(
      current,
      extruderIndex,
      fromIndex,
      toIndex,
      next
    ))
  }

  const recalculate = (extruderIndex: number) => {
    setMatrixTouched(true)
    setBlocks((current) => current.map((block, index) => (
      index === extruderIndex ? suggestion(index) : block
    )))
  }

  const setMultiplier = (extruderIndex: number, next: number) => {
    setSettingsTouched(true)
    setMultipliers((current) => updateMultiplier(
      current,
      activeMultiplierSet,
      extruderIndex,
      next
    ))
  }

  // Where the numbers came from, and how confidently we may say so: see `lib/flushVolumesModel.ts`.
  const footnote = FLUSH_PROVENANCE_NOTE[resolveFlushProvenance({
    hasMeasuredTables: Object.keys(datasets).length > 0,
    calibration
  })]

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 760, width: '100%' }}>
        <ModalClose />
        <Typography level="h4">Flushing volumes</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, px: 0 }}>
          <Stack spacing={1.5}>
            <Typography level="body-sm" textColor="text.tertiary">
              How much filament (mm³) to purge when swapping each material for another. Rows are the material
              being swapped out, columns the one being swapped in.
            </Typography>

            {availableModes.length > 1 && (
              <FormControl sx={{ maxWidth: 280 }}>
                <FormLabel>Purge mode</FormLabel>
                <Select<PrimeVolumeMode>
                  size="sm"
                  value={primeVolumeMode}
                  onChange={(_event, next) => {
                    if (!next) {
                      return
                    }

                    setPrimeVolumeMode(next)
                    setSettingsTouched(true)
                  }}
                >
                  {availableModes.map((mode) => (
                    <Option key={mode} value={mode}>
                      {purgeModeLabel(mode)}
                    </Option>
                  ))}
                </Select>
                <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                  {purgeModeDescription(primeVolumeMode)}
                </Typography>
              </FormControl>
            )}

            {context.matrixInconsistent && (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                  <Typography level="title-sm">These purge volumes don’t match this printer</Typography>
                  <Typography level="body-sm">
                    The project was saved for a different printer and its purge volumes weren’t fully updated,
                    which can make slicing fail. Repairing rebuilds them for this machine.
                  </Typography>
                  {onRepair && (
                    <Box>
                      <Button type="button" size="sm" variant="soft" color="warning" onClick={onRepair}>
                        Repair
                      </Button>
                    </Box>
                  )}
                </Stack>
              </Alert>
            )}

            {previewing && (
              <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                <Typography level="body-sm">
                  This project doesn’t set its own purge volumes, so Bambu Studio works them out when it slices.
                  These are the values it would use. Change any of them to set them for this project instead.
                </Typography>
              </Alert>
            )}

            {context.extruderCount > 1 ? (
              <Tabs value={extruderTab} onChange={(_event, next) => setExtruderTab(Number(next ?? 0))}>
                <TabList size="sm">
                  {Array.from({ length: context.extruderCount }, (_unused, index) => (
                    <Tab key={index} value={index}>{extruderLabels[index] ?? `Nozzle ${index + 1}`}</Tab>
                  ))}
                </TabList>
                {Array.from({ length: context.extruderCount }, (_unused, index) => (
                  <TabPanel key={index} value={index} sx={{ px: 0 }}>
                    <ExtruderPanel
                      filaments={filaments}
                      values={blocks[index] ?? []}
                      multiplier={multiplier[index] ?? 1}
                      onCellChange={(from, to, next) => setCell(index, from, to, next)}
                      onMultiplierChange={(next) => setMultiplier(index, next)}
                      onRecalculate={() => recalculate(index)}
                    />
                  </TabPanel>
                ))}
              </Tabs>
            ) : (
              <ExtruderPanel
                filaments={filaments}
                values={blocks[0] ?? []}
                multiplier={multiplier[0] ?? 1}
                onCellChange={(from, to, next) => setCell(0, from, to, next)}
                onMultiplierChange={(next) => setMultiplier(0, next)}
                onRecalculate={() => recalculate(0)}
              />
            )}

            <Divider />
            <Typography level="body-xs" textColor="text.tertiary">
              {footnote}
            </Typography>
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button type="button" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            // A purge-mode or multiplier edit may be saved while the grid is still a preview. Its
            // null matrix preserves the project's deliberate absence instead of claiming the
            // suggested cells as user-authored values.
            disabled={!dirty}
            onClick={() => onApply({
              matrix: matrixTouched ? blocks.map((block) => block.map((row) => [...row])) : null,
              multiplier,
              primeVolumeMode
            })}
          >
            Save
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

/** One extruder's grid plus the controls that apply to it. */
function ExtruderPanel({ filaments, values, multiplier, onCellChange, onMultiplierChange, onRecalculate }: {
  filaments: FlushGridFilament[]
  values: number[][]
  multiplier: number
  onCellChange: (fromIndex: number, toIndex: number, value: number) => void
  onMultiplierChange: (value: number) => void
  onRecalculate: () => void
}): JSX.Element {
  return (
    <Stack spacing={1.5}>
      <FlushVolumesGrid filaments={filaments} values={values} onChange={onCellChange} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
        <FormControl sx={{ maxWidth: { sm: 180 } }}>
          <FormLabel>Multiplier</FormLabel>
          <Tooltip title={`Scales every volume above. ${FLUSH_MULTIPLIER_RANGE.min} to ${FLUSH_MULTIPLIER_RANGE.max}.`} variant="soft">
            <Input
              size="sm"
              type="number"
              value={multiplier}
              slotProps={{
                input: {
                  min: FLUSH_MULTIPLIER_RANGE.min,
                  max: FLUSH_MULTIPLIER_RANGE.max,
                  step: 0.1,
                  'aria-label': 'Purge volume multiplier'
                }
              }}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!Number.isFinite(next)) return
                onMultiplierChange(Math.min(Math.max(next, FLUSH_MULTIPLIER_RANGE.min), FLUSH_MULTIPLIER_RANGE.max))
              }}
            />
          </Tooltip>
        </FormControl>
        <Box sx={{ ml: { sm: 'auto' } }}>
          <Button
            type="button"
            size="sm"
            variant="soft"
            startDecorator={<CalculateRoundedIcon />}
            onClick={onRecalculate}
          >
            Calculate from colours
          </Button>
        </Box>
      </Stack>
    </Stack>
  )
}

/** Rounds a purge volume to the non-negative integer unit accepted by the slicer. */
function clampVolume(value: number): number {
  return Math.max(0, Math.round(value))
}

/** Maps a purge mode to the independent multiplier set Bambu stores for it. */
function multiplierSetFor(mode: PrimeVolumeMode): 'normal' | 'fast' {
  return mode === 'Fast' ? 'fast' : 'normal'
}

/** Updates one matrix cell without mutating the surrounding React state. */
function updateFlushCell(
  blocks: number[][][],
  extruderIndex: number,
  fromIndex: number,
  toIndex: number,
  value: number
): number[][][] {
  return blocks.map((block, candidateExtruder) => {
    if (candidateExtruder !== extruderIndex) {
      return block
    }

    return block.map((row, candidateRow) => {
      if (candidateRow !== fromIndex) {
        return row
      }

      return row.map((cell, candidateColumn) => (
        candidateColumn === toIndex ? clampVolume(value) : cell
      ))
    })
  })
}

/** Updates one extruder's multiplier while preserving the inactive mode's values. */
function updateMultiplier(
  multipliers: Record<'normal' | 'fast', number[]>,
  activeSet: 'normal' | 'fast',
  extruderIndex: number,
  value: number
): Record<'normal' | 'fast', number[]> {
  return {
    ...multipliers,
    [activeSet]: multipliers[activeSet].map((entry, index) => (
      index === extruderIndex ? value : entry
    ))
  }
}

/** Returns the user-facing name for Bambu's persisted purge-mode value. */
function purgeModeLabel(mode: PrimeVolumeMode): string {
  if (mode === 'Saving') {
    return 'Prime Saving'
  }

  if (mode === 'Fast') {
    return 'Fast'
  }

  return 'Standard'
}

/** Summarizes the print-quality trade-off for the selected purge mode. */
function purgeModeDescription(mode: PrimeVolumeMode): string {
  if (mode === 'Saving') {
    return 'Uses less purge material and prints faster, with some risk of colour mixing or small surface defects.'
  }

  if (mode === 'Fast') {
    return 'Uses faster purging tuned for this printer, with some risk of slight colour mixing.'
  }

  return 'Performs a full purge for the best print quality.'
}
