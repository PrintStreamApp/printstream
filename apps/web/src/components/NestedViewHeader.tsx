import React from 'react'
import { Stack, Typography } from '@mui/joy'

type NestedViewHeaderCrumb = {
  label: string
  onClick?: () => void
}

/**
 * Shared header for nested views with breadcrumb-style parent navigation.
 */
export function NestedViewHeader({
  crumbs,
  description,
  action,
  children
}: {
  crumbs: NestedViewHeaderCrumb[]
  description?: string
  /** Right-aligned control on the breadcrumb/title row. */
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <Stack spacing={0.75}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ minWidth: 0 }}>
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="baseline"
          sx={{ minWidth: 0, flexWrap: action ? 'nowrap' : 'wrap' }}
        >
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1
            return (
              <Stack key={`${crumb.label}:${index}`} direction="row" spacing={0.75} alignItems="baseline" sx={{ minWidth: isLast && action ? 0 : undefined }}>
                {crumb.onClick && !isLast ? (
                  <Typography
                    level="h3"
                    component="button"
                    onClick={crumb.onClick}
                    sx={{
                      appearance: 'none',
                      border: 0,
                      borderRadius: 'xs',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      m: 0,
                      p: 0,
                      textAlign: 'left',
                      '&:hover': { color: 'primary.300' },
                      '&:focus-visible': {
                        outline: '2px solid',
                        outlineColor: 'primary.400',
                        outlineOffset: 3
                      }
                    }}
                  >
                    {crumb.label}
                  </Typography>
                ) : (
                  <Typography level="h3" textColor={isLast ? 'text.primary' : 'text.tertiary'} noWrap={Boolean(isLast && action)}>
                    {crumb.label}
                  </Typography>
                )}
                {!isLast && (
                  <Typography level="h3" textColor="text.tertiary">
                    /
                  </Typography>
                )}
              </Stack>
            )
          })}
        </Stack>
        {action ? <Stack sx={{ flexShrink: 0 }}>{action}</Stack> : null}
      </Stack>

      {(description || children) ? (
        <Stack spacing={0.5}>
          {description ? (
            <Typography level="body-sm" textColor="text.tertiary">
              {description}
            </Typography>
          ) : null}
          {children}
        </Stack>
      ) : null}
    </Stack>
  )
}
