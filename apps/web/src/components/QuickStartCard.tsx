/**
 * One card in the Get started checklist: an icon, a title, a line of explanation, and an optional
 * destination.
 *
 * Shared rather than local to `GetStartedView` because plugins contribute cards to that page
 * through the `quickstart.tips` slot, and a plugin rebuilding this shape by hand is how one page
 * comes to look like two. Without `actionTo` the card renders inert (no chevron, no hover), which
 * is what a completed step or an action the viewer lacks permission for should look like.
 */
import type { ReactNode } from 'react'
import { Card, CardContent, Stack, Typography } from '@mui/joy'
import { Link as RouterLink } from 'react-router-dom'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'

export function QuickStartCard({
  icon,
  title,
  description,
  actionTo
}: {
  icon: ReactNode
  title: string
  description: string
  actionTo?: string
}) {
  const content = (
    <CardContent>
      <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="center">
        <Stack spacing={1.25} sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="title-lg" sx={{ display: 'inline-flex', alignItems: 'center' }}>
              {icon}
            </Typography>
            <Typography level="title-lg">{title}</Typography>
          </Stack>
          <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
        </Stack>
        {actionTo ? (
          <Typography
            aria-hidden="true"
            level="title-lg"
            textColor="text.tertiary"
            sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
          >
            <KeyboardArrowRightRoundedIcon />
          </Typography>
        ) : null}
      </Stack>
    </CardContent>
  )

  const cardSx = {
    textAlign: 'left',
    ...(actionTo
      ? {
          cursor: 'pointer',
          textDecoration: 'none',
          color: 'inherit',
          transition: 'background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
          '&:hover': {
            backgroundColor: 'background.level1',
            borderColor: 'primary.softColor'
          },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'focusVisible',
            outlineOffset: '2px'
          }
        }
      : {})
  } as const

  if (actionTo) {
    return (
      <Card component={RouterLink} to={actionTo} variant="outlined" sx={cardSx}>
        {content}
      </Card>
    )
  }

  return (
    <Card variant="outlined" sx={cardSx}>
      {content}
    </Card>
  )
}
