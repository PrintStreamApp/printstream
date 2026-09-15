/**
 * Shared action row shown immediately above selectable directory results.
 *
 * The leading label supplies the subject for each compact action ("With selected"), so callers
 * label buttons with the verb only. Cancel stays in the same action cluster so the way out of
 * selection mode remains easy to notice.
 */
import { Button, Stack, Typography } from '@mui/joy'
import type { ReactNode } from 'react'

export function BulkSelectionActions({
  children,
  onCancel,
  cancelDisabled = false
}: {
  children: ReactNode
  onCancel: () => void
  cancelDisabled?: boolean
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      alignItems="center"
      sx={{ flexWrap: 'wrap' }}
    >
      <Typography
        level="body-sm"
        textColor="text.tertiary"
        sx={{ flexBasis: { xs: '100%', sm: 'auto' } }}
      >
        With selected:
      </Typography>
      {children}
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={onCancel}
        disabled={cancelDisabled}
      >
        Cancel
      </Button>
    </Stack>
  )
}
