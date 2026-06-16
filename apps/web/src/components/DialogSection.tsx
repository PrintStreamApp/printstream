import { Box, Sheet, Typography } from '@mui/joy'
import type { ReactNode } from 'react'

/**
 * Shared section wrapper for multi-group dialogs.
 *
 * Keeps the section title and helper text outside the outlined surface so
 * dialog bodies scan like the slice and print flows.
 */
export function DialogSection({
  title,
  description,
  wrapInSheet = true,
  children
}: {
  title: ReactNode
  description?: ReactNode
  wrapInSheet?: boolean
  children: ReactNode
}) {
  return (
    <Box>
      <Typography level="title-sm" sx={{ mb: 1 }}>{title}</Typography>
      {description ? (
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          {description}
        </Typography>
      ) : null}
      {wrapInSheet ? (
        <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
          {children}
        </Sheet>
      ) : children}
    </Box>
  )
}