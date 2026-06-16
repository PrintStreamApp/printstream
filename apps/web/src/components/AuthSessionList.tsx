import { Alert, Box, Button, Card, CardContent, Chip, Stack, Typography } from '@mui/joy'
import React from 'react'
import type { ReactNode } from 'react'
import type { AuthSessionSummary } from '@printstream/shared'

/**
 * Reusable auth session list for self-service and admin session management.
 */
export function AuthSessionList({
  sessions,
  emptyMessage,
  revokingSessionId,
  onRevoke,
  actionsDisabled = false,
  cardVariant = 'soft'
}: {
  sessions: AuthSessionSummary[]
  emptyMessage: string
  revokingSessionId: string | null
  onRevoke?: (sessionId: string) => void
  actionsDisabled?: boolean
  cardVariant?: 'soft' | 'outlined'
}) {
  if (sessions.length === 0) {
    return (
      <Alert color="neutral" variant="soft">
        {emptyMessage}
      </Alert>
    )
  }

  return (
    <Stack spacing={1}>
      {sessions.map((session) => {
        const description = describeSession(session)
        const canRevoke = Boolean(onRevoke) && !session.current

        return (
          <Card key={session.id} variant={cardVariant}>
            <CardContent>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1.25}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', sm: 'center' }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                    <Typography level="title-sm">{description.label}</Typography>
                    {session.current && <Chip size="sm" variant="soft" color="primary">Current</Chip>}
                  </Stack>
                  <Stack spacing={0.25} sx={{ mt: 0.25 }}>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {description.detail}
                    </Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      Created {formatDateTime(session.createdAt)}
                    </Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {session.lastSeenAt
                        ? `Last active ${formatDateTime(session.lastSeenAt)}`
                        : 'Last active time unavailable'}
                    </Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      Expires {formatDateTime(session.expiresAt)}
                    </Typography>
                  </Stack>
                </Box>

                {canRevoke && onRevoke && (
                  <Button
                    size="sm"
                    variant="plain"
                    color="danger"
                    loading={revokingSessionId === session.id}
                    disabled={actionsDisabled}
                    onClick={() => onRevoke(session.id)}
                  >
                    Revoke
                  </Button>
                )}
              </Stack>
            </CardContent>
          </Card>
        )
      })}
    </Stack>
  )
}

function describeSession(session: AuthSessionSummary): { label: string; detail: ReactNode } {
  const browser = detectBrowser(session.userAgent)
  const platform = detectPlatform(session.userAgent)

  if (!browser && !platform) {
    return {
      label: session.current ? 'This browser' : 'Unknown browser or device',
      detail: session.userAgent?.trim() || 'No browser metadata reported.'
    }
  }

  return {
    label: [browser, platform].filter(Boolean).join(' on '),
    detail: session.userAgent?.trim() || 'Browser metadata available.'
  }
}

function detectBrowser(userAgent: string | null): string | null {
  if (!userAgent) return null
  if (/edg\//i.test(userAgent)) return 'Microsoft Edge'
  if (/firefox\//i.test(userAgent)) return 'Firefox'
  if (/chrome\//i.test(userAgent) && !/edg\//i.test(userAgent)) return 'Chrome'
  if (/safari\//i.test(userAgent) && !/chrome\//i.test(userAgent)) return 'Safari'
  return null
}

function detectPlatform(userAgent: string | null): string | null {
  if (!userAgent) return null
  if (/iphone/i.test(userAgent)) return 'iPhone'
  if (/ipad/i.test(userAgent)) return 'iPad'
  if (/android/i.test(userAgent)) return 'Android'
  if (/mac os x|macintosh/i.test(userAgent)) return 'macOS'
  if (/windows/i.test(userAgent)) return 'Windows'
  if (/linux/i.test(userAgent)) return 'Linux'
  return null
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}