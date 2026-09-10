/**
 * Card chrome for one personal notification channel on the account page.
 *
 * Owned by core alongside the `account.notifications` slot it is the shape
 * of, so every plugin contributing there renders at one heading level and one
 * padding, the way the plugin-manager card already unifies the same panels in
 * Settings. A contribution supplies only its title, icon and body.
 */
import type { ReactNode } from 'react'
import { Card, CardContent, Stack, Typography } from '@mui/joy'

export function AccountNotificationChannelCard({
  icon,
  title,
  children
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.25}>
          <Typography level="title-sm" startDecorator={icon}>{title}</Typography>
          {children}
        </Stack>
      </CardContent>
    </Card>
  )
}
