/**
 * BambuStudio's variable layer height editor for one object: the draggable thickness bar plus
 * Adaptive / Smooth / Reset.
 *
 * Presentational. The profile is handed in and every edit goes back through `onChange`; the editor
 * owns the state, the emit, and the object's geometry.
 *
 * The bar is a vertical strip representing the model from base (bottom) to top, painted with the
 * layer thickness at each height. Studio's four verbs are on the same control:
 * left drag thins ("add detail"), right drag thickens ("remove detail"), Shift+left resets that
 * band toward the process layer height, Shift+right smooths it, and the wheel resizes the brush.
 *
 * **It shouts about height ranges on purpose.** A layer-height profile OVERRIDES the `layer_height`
 * of any height range on the same object: the engine only falls back to the ranges when the
 * profile is absent or fails validation (`PrintObject.cpp:3340`). Two features that quietly fight
 * is the worst outcome here, so when the object has both, this says which one is winning.
 */
import { Alert, Button, Chip, IconButton, Slider, Stack, Switch, Typography } from '@mui/joy'
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded'
import BlurOnRoundedIcon from '@mui/icons-material/BlurOnRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { layerHeightAt, type LayerHeightBounds } from '@printstream/shared/three-mf'
import type { LayerHeightPaintAction } from '@printstream/shared/three-mf'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import { TOOL_PANEL_Z_INDEX } from './editorLayers'
import { VIEW_CUBE_EDGE_INSET, VIEW_CUBE_SIZE } from './lib/viewCube'
import { layerHeightZoneCss } from './lib/layerHeightOverlay'

/** Studio's brush band width limits, mm (`GLCanvas3D.cpp:4752`). */
const MIN_BAND_WIDTH_MM = 1.5
const MAX_BAND_WIDTH_MM = 10

export interface LayerHeightPanelProps {
  objectName: string
  /** The object's printable height, mm. The bar maps its full range onto this. */
  objectHeight: number
  /** Current profile (alternating z/height). Empty means "not variable yet". */
  profile: ReadonlyArray<number>
  bounds: LayerHeightBounds
  /** The process layer height, i.e. what an object with no profile yet prints at. */
  nominalHeight: number
  /** Whether the same object also carries height ranges, whose layer heights this overrides. */
  hasHeightRanges: boolean
  /**
   * One brush sample. `firstOfStroke` marks the pointer-down sample, so the editor can record a
   * SINGLE undo checkpoint per stroke rather than one per pointer event.
   */
  onPaint: (z: number, action: LayerHeightPaintAction, bandWidth: number, firstOfStroke: boolean) => void
  /**
   * The band the pointer is over, so the viewport can show WHERE a stroke lands. Null when the
   * pointer leaves the bar. Without this the bar is a strip with no relationship to the model.
   */
  onHover: (z: number | null, bandWidth: number) => void
  onAdaptive: (quality: number) => void
  onSmooth: (radius: number, keepMin: boolean) => void
  onReset: () => void
  onClose: () => void
}

export function LayerHeightPanel({
  objectName, objectHeight, profile, bounds, nominalHeight, hasHeightRanges,
  onPaint, onHover, onAdaptive, onSmooth, onReset, onClose
}: LayerHeightPanelProps) {
  const [quality, setQuality] = useState(0.5)
  const [radius, setRadius] = useState(5)
  const [keepMin, setKeepMin] = useState(false)
  const [bandWidth, setBandWidth] = useState(2)
  const [hoverZ, setHoverZ] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const painting = useRef(false)

  /** Bar coordinates run bottom-up: the model's base is at the bottom edge. */
  const zFromEvent = (event: ReactPointerEvent<HTMLDivElement>): number | null => {
    const box = barRef.current?.getBoundingClientRect()
    if (!box || box.height <= 0) return null
    const fraction = 1 - (event.clientY - box.top) / box.height
    return Math.min(Math.max(fraction, 0), 1) * objectHeight
  }

  const actionFor = (event: ReactPointerEvent<HTMLDivElement>): LayerHeightPaintAction => {
    const right = event.button === 2 || (event.buttons & 2) !== 0
    if (event.shiftKey) return right ? 'smooth' : 'resetToBase'
    return right ? 'removeDetail' : 'addDetail'
  }

  const paintAt = (event: ReactPointerEvent<HTMLDivElement>, firstOfStroke: boolean) => {
    const z = zFromEvent(event)
    if (z == null) return
    onPaint(z, actionFor(event), bandWidth, firstOfStroke)
  }

  const bands = profileBands(profile, objectHeight, bounds, nominalHeight)

  return (
    // One row spanning the viewport's usable height: the bar STRETCHES to fill it, the controls sit
    // beside it at their natural size. The row itself is click-through so the empty space beside the
    // controls does not eat viewport drags; the bar and the panel each opt back in.
    <Stack
      direction="row"
      spacing={1}
      sx={{
        position: 'absolute', ...TOOL_PANEL_ANCHOR,
        // Derived, not guessed: the view cube sits at this inset with this size, so a hardcoded
        // number drifts the moment either changes. The previous 88 was 12px short and clipped the
        // cube's top-left corner while claiming in a comment to clear it.
        bottom: VIEW_CUBE_EDGE_INSET * 2 + VIEW_CUBE_SIZE,
        zIndex: TOOL_PANEL_Z_INDEX,
        alignItems: 'stretch', pointerEvents: 'none',
        maxWidth: 'calc(100% - 16px)'
      }}
    >
      {/* The thickness bar. Right-click is captured so the browser menu never interrupts a stroke. */}
      <Stack
        ref={barRef}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          painting.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
          paintAt(event, true)
        }}
        onPointerMove={(event) => {
          const z = zFromEvent(event)
          setHoverZ(z)
          onHover(z, bandWidth)
          if (painting.current) paintAt(event, false)
        }}
        // Pointer capture keeps a drag alive past the bar's edges, so a leave mid-stroke is the
        // pointer wandering, not the stroke ending: keep showing the band it is still painting.
        onPointerLeave={() => { if (!painting.current) { setHoverZ(null); onHover(null, bandWidth) } }}
        onPointerUp={(event) => {
          painting.current = false
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onWheel={(event: ReactWheelEvent<HTMLDivElement>) => {
          setBandWidth((current) => Math.min(Math.max(
            current * (1 + 0.1 * (event.deltaY < 0 ? 1 : -1)), MIN_BAND_WIDTH_MM), MAX_BAND_WIDTH_MM))
        }}
        aria-label={`Layer thickness for ${objectName}: drag to paint`}
        sx={{
          position: 'relative', pointerEvents: 'auto',
          // No fixed height: the row stretches this to the viewport, so the model's full height maps
          // onto as many pixels as the view has. At the old fixed 220px a millimetre was a fraction
          // of a pixel on a tall model, which is most of why aiming a stroke felt like guessing.
          width: { xs: 34, sm: 48 }, flexShrink: 0, cursor: 'ns-resize', userSelect: 'none',
          borderRadius: 'sm', overflow: 'hidden', border: '1px solid', borderColor: 'neutral.outlinedBorder',
          display: 'flex', flexDirection: 'column-reverse'
        }}
      >
        {bands.map((band, index) => (
          <Stack key={index} sx={{ flex: 1, bgcolor: band }} />
        ))}
        {/* The brush's reach, matching the model's cursor: same extent (BambuStudio's bandWidth/1.8
            half-width) and the same fade to nothing at the rim, so the two read as one cursor. A
            hard-edged block here would contradict the soft one on the model. */}
        {hoverZ != null && objectHeight > 0 && (
          <Stack
            sx={{
              position: 'absolute', left: 0, right: 0, pointerEvents: 'none',
              bottom: `${(Math.max(hoverZ - bandWidth / 1.8, 0) / objectHeight) * 100}%`,
              height: `${(Math.min((2 * bandWidth) / 1.8, objectHeight) / objectHeight) * 100}%`,
              background: 'linear-gradient(to bottom, rgba(255,255,0,0) 0%, rgba(255,255,0,0.5) 50%, rgba(255,255,0,0) 100%)'
            }}
          />
        )}
      </Stack>

      {/* Controls. Top-aligned rather than stretched: they have a natural height and the bar owns
          the vertical space. */}
      <Stack
        spacing={1}
        sx={{
          pointerEvents: 'auto', alignSelf: 'flex-start', overflowY: 'auto', maxHeight: '100%',
          p: 1.25, borderRadius: 'sm', boxShadow: 'sm', bgcolor: 'background.level1',
          width: 'min(280px, 100%)', minWidth: 0
        }}
      >
        <Typography level="title-sm">Variable layer height</Typography>

        {hasHeightRanges && (
          <Alert size="sm" color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
            <Typography level="body-xs">
              This model also has height ranges. A layer height profile <b>overrides</b> their layer
              heights when slicing; their other settings still apply. Reset the profile to hand
              layer height back to the ranges.
            </Typography>
          </Alert>
        )}

        {/* Anchors the bar to the model: which height it is pointing at, and what prints there. */}
        <Typography level="body-xs" textColor={hoverZ == null ? 'text.tertiary' : 'text.primary'}>
          {hoverZ == null
            ? 'Point at the bar to highlight that height on the model.'
            : `${hoverZ.toFixed(1)} mm up · layers ${layerHeightAtOrNominal(profile, hoverZ, nominalHeight).toFixed(3)} mm`}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          Drag: thinner · Right-drag: thicker · Shift: reset / smooth · Wheel: brush {bandWidth.toFixed(1)} mm
        </Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Chip size="sm" variant="soft">{bounds.min.toFixed(2)}–{bounds.max.toFixed(2)} mm</Chip>
          <Chip size="sm" variant="soft" color={profile.length > 0 ? 'primary' : 'neutral'}>
            {profile.length > 0 ? `${profile.length / 2} points` : 'uniform'}
          </Chip>
        </Stack>

      <Stack spacing={0.5}>
        <Typography level="body-xs" textColor="text.tertiary">Quality vs speed</Typography>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Slider
            size="sm" min={0} max={1} step={0.05} value={quality}
            onChange={(_event, value) => setQuality(value as number)}
            aria-label="Adaptive quality"
            sx={{ flex: 1 }}
          />
          <Button size="sm" variant="soft" startDecorator={<AutoAwesomeRoundedIcon />} onClick={() => onAdaptive(quality)}>
            Adaptive
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={0.5}>
        <Typography level="body-xs" textColor="text.tertiary">Smoothing radius</Typography>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Slider
            size="sm" min={1} max={10} step={1} value={radius}
            onChange={(_event, value) => setRadius(value as number)}
            aria-label="Smoothing radius"
            sx={{ flex: 1 }}
          />
          <Button size="sm" variant="soft" startDecorator={<BlurOnRoundedIcon />} onClick={() => onSmooth(radius, keepMin)}>
            Smooth
          </Button>
        </Stack>
        <Switch
          size="sm"
          checked={keepMin}
          onChange={(event) => setKeepMin(event.target.checked)}
          endDecorator={<Typography level="body-xs">Keep min (never thicken)</Typography>}
        />
      </Stack>

      <Stack direction="row" spacing={0.75} justifyContent="flex-end">
        <IconButton size="sm" variant="plain" color="danger" aria-label="Reset to uniform layer height" onClick={onReset}>
          <RestartAltRoundedIcon />
        </IconButton>
        <Button size="sm" variant="plain" color="neutral" onClick={onClose}>Done</Button>
      </Stack>
      </Stack>
    </Stack>
  )
}

/**
 * The layer height printed at `z`, falling back to the process height where there is no profile.
 * Matching the viewport overlay's own fallback, so a flat object reads the same in both places.
 */
function layerHeightAtOrNominal(profile: ReadonlyArray<number>, z: number, nominalHeight: number): number {
  return profile.length >= 2 ? layerHeightAt(profile, z) : nominalHeight
}

/**
 * Sample the profile into evenly spaced slices, each already resolved to its ZONE colour, for the
 * bar's shading. A profile-less object reads as its uniform process height rather than as blank.
 *
 * The colour comes from the same helper the viewport overlay uses, so a zone is the same colour on
 * the bar as it is on the model: that correspondence is the entire reason the bar is legible.
 * The slice count is well above the zone count on purpose, so a zone BOUNDARY lands within a slice
 * of its true height instead of being quantized twice.
 */
function profileBands(
  profile: ReadonlyArray<number>, objectHeight: number, bounds: LayerHeightBounds, nominalHeight: number
): string[] {
  const slices = 160
  return Array.from({ length: slices }, (_unused, index) => {
    const z = ((index + 0.5) / slices) * objectHeight
    return layerHeightZoneCss(layerHeightAtOrNominal(profile, z, nominalHeight), bounds)
  })
}
