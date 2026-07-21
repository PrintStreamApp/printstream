/**
 * License banner for self-hosted installs (core). Surfaces enforcement state:
 * a countdown while the install is inside its grace window, and a "paused"
 * notice once printer adds and print dispatch lock.
 *
 * Both self-hosted builds are enforced, and the copy differs only in what
 * satisfies them: Docker/OSS takes a **free community key** for personal,
 * non-commercial use, while the native (paid) app requires a commercial one.
 * Docker/OSS gets the longer window because the requirement is new there — an
 * install that has been running for a year first sees this on upgrade, so the
 * banner has to read as "here is what to do", not "you did something wrong".
 *
 * Deliberately **not dismissible**: it reflects a countdown to real loss of
 * function. (It used to be a dismissible nudge, back when Docker/OSS was pure
 * honour system — do not restore that; a dismissed banner would let an install
 * hit the lock with no warning.)
 *
 * Renders nothing in the cloud (the query only runs when self-hosted) or on a
 * licensed install.
 */
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { Alert, Typography } from '@mui/joy'
import type { LicenseStatusResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { COMMUNITY_LICENSE_URL } from '../lib/licenseUrls'
import { useRuntimePolicy } from '../lib/runtimePolicy'

export function LicenseBanner() {
  const { selfHosted } = useRuntimePolicy()
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
  if (!enforcement.enforced || enforcement.mode === 'unrestricted') return null

  const graceEndsAt = enforcement.graceEndsAt ? new Date(enforcement.graceEndsAt) : null
  const daysLeft = graceEndsAt
    ? Math.max(0, Math.ceil((graceEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0
  const limited = enforcement.mode === 'limited'
  // An expired key is a different problem from never having had one, and the
  // fix is different too (check the subscription, not "go get a key").
  const expired = status.expired

  return (
    <Alert
      color={limited ? 'danger' : 'warning'}
      variant="soft"
      startDecorator={<WarningAmberRoundedIcon />}
      sx={{ mb: 1 }}
    >
      <Typography level="body-sm">
        {limited
          ? 'Adding printers and starting prints are paused until a license is entered under Settings → License. Everything already set up keeps working.'
          : expired
            ? `This install's license has expired: ${daysLeft} day${daysLeft === 1 ? '' : 's'} until adding printers and starting prints pause. If it came with a Pro subscription, check the subscription is active.`
            : `This install needs a license: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left before adding printers and starting prints pause.`}
        {enforcement.native ? (
          ' The native app requires a commercial license (community keys cover the Docker build only).'
        ) : (
          <>
            {' '}Personal, non-commercial use is free — grab a{' '}
            <Typography
              component="a"
              href={COMMUNITY_LICENSE_URL}
              target="_blank"
              rel="noreferrer noopener"
              level="body-sm"
              sx={{ color: 'inherit', textDecoration: 'underline' }}
            >
              community key
            </Typography>
            . Business use needs Pro or a Lifetime license.
          </>
        )}
      </Typography>
    </Alert>
  )
}
