/** Shared visual shell for a slicing job's status and result details. */
import { Chip, Sheet, Stack, Typography } from '@mui/joy'
import type { ReactNode } from 'react'

export function SliceResultPanel({
  displayName,
  statusLabel,
  statusColor,
  children
}: {
  displayName: string
  statusLabel: string
  statusColor: 'success' | 'warning' | 'danger' | 'neutral' | 'primary'
  children: ReactNode
}) {
  return (
    <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'sm' }}>
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{displayName}</Typography>
          <Chip size="sm" variant="soft" color={statusColor}>{statusLabel}</Chip>
        </Stack>
        {children}
      </Stack>
    </Sheet>
  )
}
