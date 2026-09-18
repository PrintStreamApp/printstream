/**
 * Top-down positional picker matching geometry.flowRatioPlate: left to right,
 * rear (+Y) to front (-Y). Labels are screen guides, not markings on the print.
 */
import { Box, Button, Stack, Typography } from '@mui/joy'
import { flowCalibrationColumns } from '@printstream/shared'

export function FlowPatchPicker({ offsets, value, onChange }: {
  offsets: readonly number[]
  value: number
  onChange: (value: number) => void
}) {
  const columns = flowCalibrationColumns(offsets.length)
  return (
    <Stack spacing={1}>
      <Typography level="body-sm">
        Face the printer and keep the patches in their printed positions. Tap the square with the smoothest top surface.
      </Typography>
      <Typography level="body-xs" textAlign="center">Back of printer</Typography>
      <Box role="group" aria-label="Best flow patch, viewed from the front of the printer"
        sx={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 1 }}>
        {offsets.map((offset, index) => (
          <Button
            key={offset}
            variant={value === offset ? 'solid' : 'outlined'}
            color={value === offset ? 'primary' : 'neutral'}
            aria-pressed={value === offset}
            aria-label={`Row ${Math.floor(index / columns) + 1} from back, column ${index % columns + 1} from left: ${offset > 0 ? '+' : ''}${offset}%`}
            onClick={() => onChange(offset)}
            sx={{ aspectRatio: '1', minWidth: 0 }}
          >
            {`${offset > 0 ? '+' : ''}${offset}%`}
          </Button>
        ))}
      </Box>
      <Typography level="title-sm" textAlign="center">Front of printer (you)</Typography>
      <Typography level="body-xs">
        The percentages identify positions in this diagram. They are not printed on the patches.
        If the patches were moved or rotated, their positions must be known to choose the correct result.
      </Typography>
    </Stack>
  )
}
