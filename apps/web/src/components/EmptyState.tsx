/**
 * Compact reusable empty-state surface for dashboard pages and lists.
 */
import React from 'react'
import type { ReactNode } from 'react'
import { Box, Card, CardContent, Typography } from '@mui/joy'

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <Card
      variant="outlined"
      sx={{
        borderStyle: 'dashed',
        borderColor: 'var(--printstream-empty-state-border)',
        backgroundColor: 'var(--printstream-empty-state-background)',
        boxShadow: [
          'inset 0 1px 0 var(--printstream-surface-panel-inset-highlight)',
          'var(--printstream-surface-panel-shadow)'
        ].join(', '),
        backdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
        WebkitBackdropFilter: 'var(--printstream-surface-panel-backdrop-filter)'
      }}
    >
      <CardContent
        sx={{
          alignItems: 'center',
          textAlign: 'center',
          py: compact ? { xs: 0.75, sm: 1 } : { xs: 1.5, sm: 2 },
          px: compact ? { xs: 0.5, sm: 0.75 } : { xs: 1, sm: 1.5 },
          gap: compact ? 0.75 : 1.25
        }}
      >
        <Box
          sx={{
            width: compact ? 44 : 52,
            height: compact ? 44 : 52,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            color: 'primary.softColor',
            backgroundColor: 'var(--printstream-empty-state-icon-background)',
            border: '1px solid',
            borderColor: 'var(--printstream-empty-state-icon-border)',
            boxShadow: 'inset 0 1px 0 var(--printstream-surface-panel-inset-highlight)'
          }}
        >
          {icon}
        </Box>
        <Typography level={compact ? 'title-sm' : 'title-md'}>{title}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ maxWidth: compact ? 380 : 440 }}>
          {description}
        </Typography>
        {action}
      </CardContent>
    </Card>
  )
}
