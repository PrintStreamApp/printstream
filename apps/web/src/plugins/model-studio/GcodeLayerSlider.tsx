/**
 * Vertical G-code layer scrubber with the plate's baked filament-change and pause markers.
 * Event marks sit beside, rather than on top of, the Slider rail so they stay visible beneath the
 * thumb and remain independently focusable/clickable.
 */
import { Box, Slider, Tooltip } from '@mui/joy'
import type { GcodeLayerEventMarker } from './lib/gcodeLayerEvents'

/** Pointer target around each compact marker glyph. */
export const GCODE_LAYER_EVENT_HIT_SIZE_PX = 28

export interface GcodeLayerSliderProps {
  layerCount: number
  value: number
  markers: readonly GcodeLayerEventMarker[]
  onChange: (layer: number) => void
}

export function GcodeLayerSlider({ layerCount, value, markers, onChange }: GcodeLayerSliderProps) {
  const maxLayer = Math.max(0, layerCount - 1)
  return (
    <Box sx={{ position: 'relative', flex: 1, minHeight: 120, width: 34, overflow: 'visible' }}>
      <Slider
        orientation="vertical"
        size="sm"
        min={0}
        max={maxLayer}
        value={value}
        onChange={(_event, next) => onChange(typeof next === 'number' ? next : next[0] ?? 0)}
        aria-label="G-code layer"
        sx={{ position: 'absolute', inset: 0, mx: 'auto' }}
      />
      {markers.map((marker) => {
        const position = maxLayer === 0 ? 0 : (marker.layer / maxLayer) * 100
        const layerLabel = `layer ${marker.layer + 1} (${Number(marker.z.toFixed(2))} mm)`
        const changeLabel = marker.filamentChanges.length === 1
          ? marker.filamentChanges[0]!.filamentId == null
            ? `Filament change at ${layerLabel}`
            : `Filament change to material ${marker.filamentChanges[0]!.filamentId} at ${layerLabel}`
          : `${marker.filamentChanges.length} filament changes at ${layerLabel}`
        const pauseLabel = marker.pauseCount === 1
          ? `Pause at ${layerLabel}`
          : `${marker.pauseCount} pauses at ${layerLabel}`
        return (
          <Box key={marker.layer}>
            {marker.filamentChanges.length > 0 && (
              <Tooltip title={changeLabel} placement="left">
                <Box
                  component="button"
                  type="button"
                  aria-label={changeLabel}
                  onClick={() => onChange(marker.layer)}
                  sx={{
                    position: 'absolute',
                    zIndex: 2,
                    left: '50%',
                    bottom: `${position}%`,
                    width: GCODE_LAYER_EVENT_HIT_SIZE_PX,
                    height: GCODE_LAYER_EVENT_HIT_SIZE_PX,
                    p: 0,
                    appearance: 'none',
                    border: 0,
                    borderRadius: 'sm',
                    bgcolor: 'transparent',
                    cursor: 'pointer',
                    transform: 'translate(-31px, 50%)',
                    '&::before': {
                      content: '""',
                      position: 'absolute',
                      inset: '9.5px',
                      border: '1px solid rgba(255,255,255,0.8)',
                      borderRadius: '2px',
                      bgcolor: marker.filamentChanges.at(-1)?.color || 'primary.400',
                      boxShadow: 'sm',
                      transform: 'rotate(45deg)'
                    },
                    '&:focus-visible': {
                      outline: '2px solid var(--joy-palette-focusVisible)',
                      outlineOffset: 1
                    }
                  }}
                />
              </Tooltip>
            )}
            {marker.pauseCount > 0 && (
              <Tooltip title={pauseLabel} placement="right">
                <Box
                  component="button"
                  type="button"
                  aria-label={pauseLabel}
                  onClick={() => onChange(marker.layer)}
                  sx={{
                    position: 'absolute',
                    zIndex: 2,
                    left: '50%',
                    bottom: `${position}%`,
                    width: GCODE_LAYER_EVENT_HIT_SIZE_PX,
                    height: GCODE_LAYER_EVENT_HIT_SIZE_PX,
                    p: 0,
                    appearance: 'none',
                    border: 0,
                    borderRadius: 'sm',
                    bgcolor: 'transparent',
                    cursor: 'pointer',
                    transform: 'translate(3px, 50%)',
                    '&::before': {
                      content: '""',
                      position: 'absolute',
                      left: 8,
                      right: 8,
                      top: 12.5,
                      height: 3,
                      borderRadius: '2px',
                      bgcolor: 'warning.400',
                      boxShadow: '0 0 0 1px rgba(0,0,0,0.45)'
                    },
                    '&:focus-visible': {
                      outline: '2px solid var(--joy-palette-focusVisible)',
                      outlineOffset: 1
                    }
                  }}
                />
              </Tooltip>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
