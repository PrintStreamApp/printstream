/**
 * One-line dialog heading with the subject file's name inline to the right of the
 * title. File dialogs (editor, 3D preview, version history, print setup) share this
 * instead of spending a second header line on the name. The name is muted, sits on
 * the title's baseline, and truncates before the title does; it is omitted when null.
 */
import { Stack, Typography } from '@mui/joy'
import type { SxProps } from '@mui/joy/styles/types'
import type { ReactNode } from 'react'

export function DialogFileTitle({ title, fileName, sx }: {
  title: ReactNode
  /** Display name of the file the dialog acts on (already formatted for display). */
  fileName?: string | null
  /** Layout overrides for the heading row (margins, extra right-padding for header icons). */
  sx?: SxProps
}) {
  return (
    <Stack
      direction="row"
      alignItems="baseline"
      spacing={1.5}
      // Default right padding clears the dialog's close button; dialogs with more
      // header icons pass a larger value through `sx`.
      sx={[{ minWidth: 0, pr: 6 }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
    >
      <Typography level="h4" sx={{ flexShrink: 0 }}>{title}</Typography>
      {fileName ? (
        <Typography level="body-md" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>
          {fileName}
        </Typography>
      ) : null}
    </Stack>
  )
}
