/**
 * License banner for self-hosted installs (core). Two jobs:
 *
 * - **Native (paid) build**: surfaces the commercial-license requirement — a
 *   countdown during the evaluation window, and a limited notice once printer
 *   adds/dispatch lock. Not dismissible; it reflects enforcement.
 * - **Docker/OSS build**: a one-time, dismissible nudge on unlicensed installs
 *   pointing at the free community key (personal, non-commercial use). Pure
 *   information — nothing is enforced there — and it disappears permanently
 *   once dismissed on this device or once any key is installed.
 *
 * Renders nothing in the cloud (the query only runs when self-hosted).
 */
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { Alert, IconButton, Typography } from '@mui/joy'
import type { LicenseStatusResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { parseNullableBoolean } from '../appShellHelpers'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { apiFetch } from '../lib/apiClient'
import { COMMUNITY_LICENSE_URL } from '../lib/licenseUrls'
import { useRuntimePolicy } from '../lib/runtimePolicy'

const NUDGE_DISMISSED_KEY = 'bambu.licenseNudgeDismissed'

export function LicenseBanner() {
  const { selfHosted } = useRuntimePolicy()
  const [nudgeDismissed, setNudgeDismissed] = useLocalStorageState<boolean | null>(
    NUDGE_DISMISSED_KEY,
    null,
    parseNullableBoolean
  )
  const licenseQuery = useQuery({
    queryKey: ['license'],
    queryFn: ({ signal }) => apiFetch<LicenseStatusResponse>('/api/license', { signal }),
    enabled: selfHosted,
    staleTime: 5 * 60_000,
    meta: { suppressGlobalErrorToast: true }
  })
  const data = licenseQuery.data
  if (!data) return null
  const { status, enforcement } = data

  // Native build: enforcement state (countdown / limited). Not dismissible.
  if (enforcement.native && enforcement.mode !== 'unrestricted') {
    const graceEndsAt = enforcement.graceEndsAt ? new Date(enforcement.graceEndsAt) : null
    const daysLeft = graceEndsAt ? Math.max(0, Math.ceil((graceEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : 0
    return (
      <Alert
        color={enforcement.mode === 'limited' ? 'danger' : 'warning'}
        variant="soft"
        startDecorator={<WarningAmberRoundedIcon />}
        sx={{ mb: 1 }}
      >
        <Typography level="body-sm">
          {enforcement.mode === 'limited'
            ? 'The evaluation period has ended — adding printers and starting prints are paused until a commercial license is entered under Settings → License.'
            : `Evaluating PrintStream: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left. The native app requires a commercial license — enter it under Settings → License (community keys cover the Docker build only).`}
        </Typography>
      </Alert>
    )
  }

  // Docker/OSS build: one-time community-key nudge for unlicensed installs.
  if (!enforcement.native && !status.valid && nudgeDismissed !== true) {
    return (
      <Alert
        color="primary"
        variant="soft"
        startDecorator={<InfoOutlinedIcon />}
        endDecorator={
          <IconButton
            size="sm"
            variant="plain"
            color="primary"
            aria-label="Dismiss license reminder"
            onClick={() => setNudgeDismissed(true)}
          >
            <CloseRoundedIcon />
          </IconButton>
        }
        sx={{ mb: 1 }}
      >
        <Typography level="body-sm">
          Self-hosting for personal use? Grab your{' '}
          <Typography
            component="a"
            href={COMMUNITY_LICENSE_URL}
            target="_blank"
            rel="noreferrer noopener"
            level="body-sm"
            sx={{ color: 'inherit', textDecoration: 'underline' }}
          >
            free community license key
          </Typography>
          {' '}— it takes a minute and covers personal, non-commercial use. Business use needs a commercial license.
        </Typography>
      </Alert>
    )
  }

  return null
}
