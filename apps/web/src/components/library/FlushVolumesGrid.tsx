/**
 * The N x N purge-volume grid for one extruder: BambuStudio's "Flushing volumes" table.
 *
 * Rows are the filament being swapped OUT, columns the one being swapped IN, which is the same
 * orientation BambuStudio uses and the same order `flush_volumes_matrix` stores (row-major, row =
 * from). The diagonal is not editable: a filament never purges into itself, and the stored matrix
 * holds a hard zero there.
 *
 * Its own file because the dialog around it (tabs, multiplier, calculate, repair notice) is a
 * separate concern from rendering the table, and the table is the part that has to survive a
 * 375px viewport, it scrolls inside its own container so a 16-material project never makes the
 * page scroll sideways.
 */
import { Box, Input, Sheet, Stack, Tooltip, Typography } from '@mui/joy'
import { FLUSH_MAX_VOLUME } from '@printstream/shared'

export interface FlushGridFilament {
  /** 1-based slot number, as shown everywhere else in the editor. */
  slot: number
  color: string
  label: string
  isSupport: boolean
}

/** A single filament's swatch + slot number, used for both the row and column headers. */
function FilamentHeader({ filament, orientation }: {
  filament: FlushGridFilament
  orientation: 'row' | 'column'
}): JSX.Element {
  return (
    <Tooltip title={filament.isSupport ? `${filament.label} (support)` : filament.label} variant="soft">
      <Stack
        direction={orientation === 'row' ? 'row' : 'column'}
        spacing={0.5}
        alignItems="center"
        justifyContent="center"
        sx={{ minWidth: 0 }}
      >
        <Box
          sx={{
            width: 14,
            height: 14,
            flexShrink: 0,
            borderRadius: '3px',
            bgcolor: filament.color,
            // Every theme is dark, so a near-black filament needs an outline to read as a swatch
            // at all rather than as a hole in the table.
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.35)'
          }}
        />
        <Typography level="body-xs" textColor="text.tertiary">{filament.slot}</Typography>
      </Stack>
    </Tooltip>
  )
}

export function FlushVolumesGrid({ filaments, values, onChange, disabled }: {
  filaments: FlushGridFilament[]
  /** `values[from][to]`, in mm3. */
  values: number[][]
  onChange: (fromIndex: number, toIndex: number, value: number) => void
  disabled?: boolean
}): JSX.Element {
  const cellWidth = 68
  return (
    // The grid is the one thing here that can exceed a phone's width, so it owns the scroll.
    <Box sx={{ overflowX: 'auto', overflowY: 'hidden', pb: 0.5 }}>
      <Box
        sx={{
          display: 'grid',
          // A corner cell, then one column per destination filament.
          gridTemplateColumns: `auto repeat(${filaments.length}, ${cellWidth}px)`,
          gap: 0.5,
          alignItems: 'center',
          width: 'max-content'
        }}
      >
        <Box aria-hidden sx={{ width: 32 }} />
        {filaments.map((filament) => (
          <FilamentHeader key={`column-${filament.slot}`} filament={filament} orientation="column" />
        ))}
        {filaments.map((fromFilament, fromIndex) => (
          <Box key={`row-${fromFilament.slot}`} sx={{ display: 'contents' }}>
            <FilamentHeader filament={fromFilament} orientation="row" />
            {filaments.map((toFilament, toIndex) => {
              if (fromIndex === toIndex) {
                return (
                  <Sheet
                    key={`cell-${fromFilament.slot}-${toFilament.slot}`}
                    variant="soft"
                    sx={{ borderRadius: 'sm', height: 32, display: 'grid', placeItems: 'center', opacity: 0.5 }}
                  >
                    <Typography level="body-xs" textColor="text.tertiary">: </Typography>
                  </Sheet>
                )
              }
              return (
                <Input
                  key={`cell-${fromFilament.slot}-${toFilament.slot}`}
                  size="sm"
                  type="number"
                  disabled={disabled}
                  value={values[fromIndex]?.[toIndex] ?? 0}
                  slotProps={{
                    input: {
                      min: 0,
                      max: FLUSH_MAX_VOLUME,
                      step: 1,
                      'aria-label': `Purge from material ${fromFilament.slot} to material ${toFilament.slot}`
                    }
                  }}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    onChange(fromIndex, toIndex, Number.isFinite(next) ? next : 0)
                  }}
                  sx={{ '--Input-paddingInline': '6px' }}
                />
              )
            })}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
