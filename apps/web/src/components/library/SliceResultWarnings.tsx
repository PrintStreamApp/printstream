import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { Alert, Stack, Typography } from '@mui/joy'
import type { SlicingMetadata } from '@printstream/shared'

/**
 * Problems PrintStream predicts in a finished slice that did not fail it, shown before anyone
 * prints the result. Today these are linked copies the engine mishandles when printing by object
 * (printed together, or left out of the G-code entirely).
 *
 * Counterpart: the API computes them from the exact engine input
 * (`apps/api/src/lib/slice-input-warnings.ts`) onto `SlicingMetadata.warnings`, so this only
 * renders. Danger rather than warning, because a missing part is a print that comes out wrong.
 * Renders nothing when there are none, so callers can drop it in unconditionally.
 */
export function SliceResultWarnings({ metadata }: { metadata: SlicingMetadata }) {
  const warnings = metadata?.warnings ?? []
  if (warnings.length === 0) return null

  return (
    <Alert variant="soft" color="danger" startDecorator={<WarningAmberRoundedIcon />} sx={{ alignItems: 'flex-start' }}>
      <Stack spacing={0.5}>
        <Typography level="title-sm">This slice may not print as arranged</Typography>
        {warnings.map((warning) => (
          <Typography key={warning} level="body-sm">{warning}</Typography>
        ))}
        <Typography level="body-xs">
          Open the project in the editor to fix it, then slice again.
        </Typography>
      </Stack>
    </Alert>
  )
}
