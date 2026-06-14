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
  children
}: {
  crumbs: NestedViewHeaderCrumb[]
  description?: string
  children?: React.ReactNode
}) {
  return (
    <Stack spacing={0.75}>
      <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ flexWrap: 'wrap' }}>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1
          return (
            <Stack key={`${crumb.label}:${index}`} direction="row" spacing={0.75} alignItems="baseline">
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
                <Typography level="h3" textColor={isLast ? 'text.primary' : 'text.tertiary'}>
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