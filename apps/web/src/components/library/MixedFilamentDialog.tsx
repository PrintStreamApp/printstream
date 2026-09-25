/**
 * Add or edit a Bambu virtual mixed-filament slot.
 *
 * A mix references two or three physical project slots. Ratios are authored as exact percentages
 * summing to 100; a two-component gradient can optionally replace the constant ratio with the
 * same three-anchor Hermite curve the shared slicer evaluator previews.
 */
import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  DialogActions,
  FormControl,
  FormLabel,
  Input,
  ModalClose,
  Option,
  Select,
  Stack,
  Typography
} from '@mui/joy'
import { sampleMixedFilamentGradientCurve, type MixedFilamentConfig } from '@printstream/shared'
import { BackAwareModal } from '../BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import type { MixedMaterialChoice } from './useMaterialSlots'

export interface MixedFilamentComponentOption {
  id: number
  label: string
  type: string
  color: string
}

interface MixedFilamentDialogProps {
  open: boolean
  components: MixedFilamentComponentOption[]
  editing: MixedMaterialChoice | null
  onClose: () => void
  onApply: (choice: MixedMaterialChoice) => void
}

/**
 * Authors a virtual filament from two or three compatible physical materials.
 * The dialog owns draft validation only; applying hands one complete immutable
 * choice to the material-slot controller.
 */
export function MixedFilamentDialog({
  open,
  components,
  editing,
  onClose,
  onApply
}: MixedFilamentDialogProps): JSX.Element {
  const initialIds = editing?.mixedFilament.componentIds
    ?? components.slice(0, Math.min(2, components.length)).map((component) => component.id)
  const [componentIds, setComponentIds] = useState<number[]>(initialIds)
  const [ratios, setRatios] = useState<number[]>(
    () => percentages(editing?.mixedFilament.ratios, initialIds.length)
  )
  const [gradient, setGradient] = useState(editing?.mixedFilament.gradient ?? false)
  const [gradientPerPart, setGradientPerPart] = useState(editing?.mixedFilament.gradientPerPart ?? false)
  const initialCurve = editing?.mixedFilament.gradientCurve ?? null
  const [curveRatios, setCurveRatios] = useState<number[]>(
    () => initialGradientPercentages(initialCurve)
  )
  const [curveTouched, setCurveTouched] = useState(false)

  const selected = resolveSelectedComponents(componentIds, components)
  const selectedType = selected[0]?.type ?? ''
  const typeMismatch = selected.some((component) => component.type !== selectedType)
  const duplicate = new Set(componentIds).size !== componentIds.length
  const ratioValid = ratiosAreValid(ratios, componentIds.length)
  const valid = mixedFilamentDraftIsValid({
    componentIds,
    selectedComponentCount: selected.length,
    duplicate,
    typeMismatch,
    ratioValid
  })
  const mixedColor = useMemo(() => blendColors(selected, ratios), [selected, ratios])
  const validationMessage = mixedFilamentValidationMessage({
    duplicate,
    typeMismatch,
    ratioValid
  })

  const setComponentCount = (count: number) => {
    if (count === componentIds.length) {
      return
    }

    if (count === 2) {
      setComponentIds((current) => current.slice(0, 2))
      setRatios(percentages(undefined, 2))
      return
    }

    const next = components.find((component) => (
      !componentIds.includes(component.id) && component.type === selectedType
    ))
      ?? components.find((component) => !componentIds.includes(component.id))

    if (!next) {
      return
    }

    setComponentIds((current) => [...current, next.id])
    setRatios(percentages(undefined, 3))
    setGradient(false)
  }

  const applyDraft = () => {
    if (!valid) {
      return
    }

    onApply(buildMixedMaterialChoice({
      projectFilamentId: editing?.projectFilamentId ?? null,
      componentIds,
      ratios,
      gradient,
      gradientPerPart,
      initialCurve,
      curveRatios,
      curveTouched,
      color: mixedColor,
      type: selectedType
    }))
  }

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ width: '100%', maxWidth: 560 }}>
        <ModalClose />
        <Typography level="h4">{editing ? 'Edit mixed material' : 'Add mixed material'}</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, px: 0 }}>
          <Stack spacing={1.5}>
            <Typography level="body-sm" textColor="text.tertiary">
              Each layer alternates between the selected physical materials so the printed layer reads as their blend.
            </Typography>

            <FormControl>
              <FormLabel>Components</FormLabel>
              <Stack direction="row" spacing={1}>
                {[2, 3].map((count) => (
                  <Button
                    key={count}
                    type="button"
                    size="sm"
                    variant={componentIds.length === count ? 'solid' : 'soft'}
                    disabled={count === 3 && components.length < 3}
                    onClick={() => setComponentCount(count)}
                  >
                    {count} materials
                  </Button>
                ))}
              </Stack>
            </FormControl>

            {componentIds.map((componentId, index) => (
              <Stack key={index} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-end' }}>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Material {index + 1}</FormLabel>
                  <Select<number>
                    value={componentId}
                    onChange={(_event, next) => {
                      if (next == null) {
                        return
                      }

                      setComponentIds((current) => current.map((id, candidate) => (
                        candidate === index ? next : id
                      )))
                    }}
                  >
                    {components.map((component) => (
                      <Option
                        key={component.id}
                        value={component.id}
                        disabled={componentIds.some(
                          (id, candidate) => candidate !== index && id === component.id
                        )}
                      >
                        <Box
                          component="span"
                          sx={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            bgcolor: component.color,
                            border: '1px solid',
                            borderColor: 'divider',
                            mr: 1
                          }}
                        />
                        {component.label}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl sx={{ width: { sm: 110 } }}>
                  <FormLabel>Ratio</FormLabel>
                  <Input
                    type="number"
                    value={ratios[index] ?? 0}
                    endDecorator="%"
                    slotProps={{ input: { min: 1, max: 99, step: 1 } }}
                    onChange={(event) => {
                      const next = Number(event.target.value)

                      if (!Number.isFinite(next)) {
                        return
                      }

                      setRatios((current) => current.map((ratio, candidate) => (
                        candidate === index ? Math.round(next) : ratio
                      )))
                    }}
                  />
                </FormControl>
              </Stack>
            ))}

            {validationMessage && (
              <Alert color="danger" variant="soft">
                {validationMessage}
              </Alert>
            )}

            {componentIds.length === 2 && (
              <Stack spacing={1}>
                <Checkbox
                  checked={gradient}
                  onChange={(event) => setGradient(event.target.checked)}
                  label="Gradient effect"
                />
                {gradient && (
                  <>
                    <Typography level="body-xs" textColor="text.tertiary">
                      Component 1 share from the bottom, through the middle, to the top. The slicer keeps both materials flowing between 10% and 90%.
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      {['Bottom', 'Middle', 'Top'].map((label, index) => (
                        <FormControl key={label} sx={{ flex: 1 }}>
                          <FormLabel>{label}</FormLabel>
                          <Input
                            type="number"
                            value={curveRatios[index]}
                            endDecorator="%"
                            slotProps={{ input: { min: 10, max: 90, step: 1 } }}
                            onChange={(event) => {
                              const next = Math.min(90, Math.max(10, Math.round(Number(event.target.value))))

                              if (!Number.isFinite(next)) {
                                return
                              }

                              setCurveTouched(true)
                              setCurveRatios((current) => current.map((ratio, candidate) => (
                                candidate === index ? next : ratio
                              )))
                            }}
                          />
                        </FormControl>
                      ))}
                    </Stack>
                    <Checkbox
                      checked={gradientPerPart}
                      onChange={(event) => setGradientPerPart(event.target.checked)}
                      label="Restart the gradient for each part"
                    />
                  </>
                )}
              </Stack>
            )}

            <Stack direction="row" spacing={1} alignItems="center">
              <Box
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  bgcolor: mixedColor,
                  border: '1px solid',
                  borderColor: 'divider'
                }}
              />
              <Typography level="body-sm">Mixed {selectedType || 'material'}</Typography>
            </Stack>
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button type="button" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            disabled={!valid}
            onClick={applyDraft}
          >
            {editing ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

interface MixedFilamentDraftValidity {
  componentIds: number[]
  selectedComponentCount: number
  duplicate: boolean
  typeMismatch: boolean
  ratioValid: boolean
}

/** Checks the constraints required by the slicer's mixed-filament format. */
function mixedFilamentDraftIsValid(draft: MixedFilamentDraftValidity): boolean {
  const componentCountValid = draft.componentIds.length >= 2 && draft.componentIds.length <= 3
  const everyComponentResolved = draft.selectedComponentCount === draft.componentIds.length

  return componentCountValid
    && everyComponentResolved
    && !draft.duplicate
    && !draft.typeMismatch
    && draft.ratioValid
}

/** Returns the most actionable validation message, or null for a valid draft. */
function mixedFilamentValidationMessage(input: {
  duplicate: boolean
  typeMismatch: boolean
  ratioValid: boolean
}): string | null {
  if (input.duplicate) {
    return 'Choose each material only once.'
  }

  if (input.typeMismatch) {
    return 'Mixed components must use the same filament type.'
  }

  if (!input.ratioValid) {
    return 'Ratios must be whole percentages greater than zero and add up to 100%.'
  }

  return null
}

/** Resolves selected ids while discarding stale ids from an edited project. */
function resolveSelectedComponents(
  componentIds: number[],
  components: MixedFilamentComponentOption[]
): MixedFilamentComponentOption[] {
  return componentIds
    .map((id) => components.find((component) => component.id === id))
    .filter((component): component is MixedFilamentComponentOption => component != null)
}

/** Validates exact whole-number percentages and their required 100 percent total. */
function ratiosAreValid(ratios: number[], componentCount: number): boolean {
  return ratios.length === componentCount
    && ratios.every((ratio) => Number.isInteger(ratio) && ratio > 0)
    && ratios.reduce((sum, ratio) => sum + ratio, 0) === 100
}

/** Converts a stored curve to the three editable percentage anchors. */
function initialGradientPercentages(
  curve: MixedFilamentConfig['gradientCurve']
): number[] {
  if (!curve) {
    return [10, 50, 90]
  }

  const ratios = [
    curve[0]?.y ?? 0.1,
    sampleMixedFilamentGradientCurve(curve, 0.5),
    curve.at(-1)?.y ?? 0.9
  ]

  return ratios.map((ratio) => Math.round(ratio * 100))
}

interface MixedMaterialChoiceInputs {
  projectFilamentId: number | null
  componentIds: number[]
  ratios: number[]
  gradient: boolean
  gradientPerPart: boolean
  initialCurve: MixedFilamentConfig['gradientCurve']
  curveRatios: number[]
  curveTouched: boolean
  color: string
  type: string
}

/** Converts dialog percentages into the normalized fractional format persisted in the 3MF. */
function buildMixedMaterialChoice(input: MixedMaterialChoiceInputs): MixedMaterialChoice {
  const gradientCurve = buildGradientCurve(input)
  const gradientRange: [number, number] = input.gradient
    ? [input.curveRatios[0]! / 100, input.curveRatios[2]! / 100]
    : [0.1, 0.9]

  const config: MixedFilamentConfig = {
    componentIds: input.componentIds,
    ratios: input.ratios.map((ratio) => ratio / 100),
    gradient: input.gradient,
    gradientRange,
    gradientCurve,
    gradientPerPart: input.gradient && input.gradientPerPart,
    issues: []
  }

  return {
    projectFilamentId: input.projectFilamentId,
    color: input.color,
    type: input.type,
    mixedFilament: config
  }
}

/** Preserves an untouched source curve, otherwise authors the three visible anchors. */
function buildGradientCurve(
  input: MixedMaterialChoiceInputs
): MixedFilamentConfig['gradientCurve'] {
  if (!input.gradient) {
    return null
  }

  if (!input.curveTouched && input.initialCurve) {
    return input.initialCurve.map((anchor) => ({ ...anchor }))
  }

  return [0, 0.5, 1].map((x, index) => ({
    x,
    y: (input.curveRatios[index] ?? 50) / 100,
    mIn: null,
    mOut: null
  }))
}

/** Converts stored fractional ratios to exact percentages, repairing rounding at the tail. */
function percentages(ratios: readonly number[] | undefined, count: number): number[] {
  if (ratios?.length === count) {
    const rounded = ratios.map((ratio) => Math.round(ratio * 100))
    rounded[rounded.length - 1] = (rounded.at(-1) ?? 0) + 100 - rounded.reduce((sum, ratio) => sum + ratio, 0)
    return rounded
  }
  if (count === 3) {
    return [34, 33, 33]
  }

  return [50, 50]
}

/** Blends component swatches by their percentage weights for the virtual slot colour. */
function blendColors(components: readonly MixedFilamentComponentOption[], ratios: readonly number[]): string {
  const total = ratios.reduce((sum, ratio) => sum + Math.max(ratio, 0), 0) || 1
  const channels = [0, 1, 2].map((channel) => {
    const weightedChannel = components.reduce((sum, component, index) => {
      const hex = component.color.replace('#', '').slice(0, 6).padEnd(6, 'F')
      const channelValue = Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16)
      const weight = Math.max(ratios[index] ?? 0, 0) / total

      return sum + channelValue * weight
    }, 0)

    return Math.round(weightedChannel)
  })

  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}
