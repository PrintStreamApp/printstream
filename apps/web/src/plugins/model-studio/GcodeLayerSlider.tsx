/**
 * G-code layer scrubber with the plate's baked filament-change and pause markers.
 * Event marks sit beside, rather than on top of, the Slider rail so they stay visible beneath the
 * thumb and remain independently focusable/clickable.
 */
import React from 'react'
import { Box, Slider, Tooltip } from '@mui/joy'
import type { GcodeLayerEventMarker } from './lib/gcodeLayerEvents'

/** Pointer target around each compact marker glyph. */
export const GCODE_LAYER_EVENT_HIT_SIZE_PX = 28
/** Keeps a slider's thumb inside its rail slot at both endpoint values. */
export const GCODE_SLIDER_END_INSET_PX = 8
/** Joy's small slider keeps this minimum cross-axis size for an accessible touch target. */
export const GCODE_SLIDER_TOUCH_TARGET_SIZE_PX = 42

export interface GcodeLayerSliderProps {
  layerCount: number
  value: number
  markers: readonly GcodeLayerEventMarker[]
  onChange: (layer: number) => void
  orientation?: 'horizontal' | 'vertical'
}

export function GcodeLayerSlider({ layerCount, value, markers, onChange, orientation = 'vertical' }: GcodeLayerSliderProps) {
  const maxLayer = Math.max(0, layerCount - 1)
  const horizontal = orientation === 'horizontal'
  return (
    <Box sx={{
      position: 'relative',
      flex: 1,
      minWidth: horizontal ? 72 : undefined,
      minHeight: horizontal ? GCODE_SLIDER_TOUCH_TARGET_SIZE_PX : 120,
      width: horizontal ? 'auto' : GCODE_SLIDER_TOUCH_TARGET_SIZE_PX,
      mx: horizontal ? `${GCODE_SLIDER_END_INSET_PX}px` : undefined,
      my: horizontal ? undefined : `${GCODE_SLIDER_END_INSET_PX}px`,
      alignSelf: 'center',
      overflow: 'visible'
    }}>
      <Slider
        orientation={orientation}
        size="sm"
        min={0}
        max={maxLayer}
        value={value}
        onChange={(_event, next) => onChange(typeof next === 'number' ? next : next[0] ?? 0)}
        aria-label="G-code layer"
        sx={{ position: 'absolute', inset: 0 }}
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
                    left: horizontal ? `${position}%` : '50%',
                    bottom: horizontal ? undefined : `${position}%`,
                    top: horizontal ? '50%' : undefined,
                    width: GCODE_LAYER_EVENT_HIT_SIZE_PX,
                    height: GCODE_LAYER_EVENT_HIT_SIZE_PX,
                    p: 0,
                    appearance: 'none',
                    border: 0,
                    borderRadius: 'sm',
                    bgcolor: 'transparent',
                    cursor: 'pointer',
                    transform: horizontal ? 'translate(-50%, -24px)' : 'translate(-28px, 50%)',
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
                    left: horizontal ? `${position}%` : '50%',
                    bottom: horizontal ? undefined : `${position}%`,
                    top: horizontal ? '50%' : undefined,
                    width: GCODE_LAYER_EVENT_HIT_SIZE_PX,
                    height: GCODE_LAYER_EVENT_HIT_SIZE_PX,
                    p: 0,
                    appearance: 'none',
                    border: 0,
                    borderRadius: 'sm',
                    bgcolor: 'transparent',
                    cursor: 'pointer',
                    transform: horizontal ? 'translate(-50%, -4px)' : 'translate(0, 50%)',
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
