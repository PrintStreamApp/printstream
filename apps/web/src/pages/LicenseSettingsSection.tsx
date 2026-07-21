/**
 * Self-hosted license settings (core/public). Shows the installed license, what
 * it permits, and (with settings.manage) lets an operator paste or remove a key.
 * Rendered only in self-hosted mode; the multi-tenant cloud licenses via
 * subscriptions and has no key.
 *
 * Three keys can be installed and the copy must not conflate them:
 * - **Community** — free, perpetual, personal/non-commercial. Satisfies the
 *   Docker/OSS build only.
 * - **Lifetime** — a one-time purchase: perpetual commercial use, with an
 *   annual updates & support addon that can lapse without stopping the app.
 * - **Pro subscription** — carries an `expiresAt` and refreshes itself against
 *   the vendor cloud, so it needs no operator attention at all. The one thing
 *   worth surfacing is the run window, since a subscription that ends will
 *   eventually stop this install.
 *
 * Counterpart: `apps/api/src/routes/license.ts` and `license-enforcement.ts`,
 * whose `mode` drives the warning states here.
 */
import { Alert, Box, Button, Card, CardContent, Chip, Input, Stack, Typography } from '@mui/joy'
import { extractErrorMessage } from '@printstream/shared'
import type { LicenseStatus, LicenseStatusResponse } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../lib/apiClient'
import { COMMUNITY_LICENSE_URL } from '../lib/licenseUrls'

/** A subscription-backed key is the one that carries a run window. */
function isSubscriptionKey(status: LicenseStatus): boolean {
  return status.edition === 'commercial' && status.expiresAt != null
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString()
}

export function LicenseSettingsSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const licenseQuery = useQuery({
    queryKey: ['license'],
    queryFn: ({ signal }) => apiFetch<LicenseStatusResponse>('/api/license', { signal })
  })

  const saveMutation = useMutation({
    mutationFn: (value: string) => apiFetch<LicenseStatusResponse>('/api/license', { method: 'PUT', body: { key: value } }),
    onSuccess: () => { setError(null); setKey(''); void queryClient.invalidateQueries({ queryKey: ['license'] }) },
    onError: (mutationError) => setError(extractErrorMessage(mutationError, 'Could not save the license key.'))
  })
  const removeMutation = useMutation({
    mutationFn: () => apiFetch('/api/license', { method: 'DELETE' }),
    onSuccess: () => { setError(null); void queryClient.invalidateQueries({ queryKey: ['license'] }) },
    onError: (mutationError) => setError(extractErrorMessage(mutationError, 'Could not remove the license.'))
  })

  const status = licenseQuery.data?.status
  const enforcement = licenseQuery.data?.enforcement
  const isNative = enforcement?.native === true
  const isCommercial = status?.valid === true && status.edition === 'commercial'
  const isCommunity = status?.valid === true && status.edition === 'community'
  // An expired key is still *installed* — say so, rather than "unlicensed",
  // which would send the operator hunting for a key they already pasted.
  const isExpired = status?.expired === true
  const subscription = status ? isSubscriptionKey(status) : false

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography level="title-md">License</Typography>
            {status?.valid ? (
              <Chip size="sm" variant="soft" color={isCommercial ? 'primary' : 'neutral'}>
                {isCommercial ? (subscription ? 'Pro' : 'Lifetime') : 'Community'}
              </Chip>
            ) : (
              <Chip size="sm" variant="soft" color="warning">{isExpired ? 'Expired' : 'Unlicensed'}</Chip>
            )}
          </Stack>

          {!isCommercial ? (
            <Alert color="warning" variant="soft">
              {isExpired
                ? 'This license has expired. If it came with a Pro subscription, check that the subscription is still active; otherwise enter a new key below.'
                : isNative
                  ? (isCommunity
                      ? 'A community key is installed, but the native app requires a commercial license — community keys cover the Docker build only.'
                      : 'The native app requires a commercial license. Enter one below to keep full functionality past the evaluation period.')
                  : isCommunity
                    ? 'Community edition — licensed for personal, non-commercial use only. A commercial license is required for business use.'
                    : 'This install needs a license. A community key is free for personal, non-commercial use; business use needs Pro or a Lifetime license.'}
              <Box sx={{ mt: 0.5 }}>
                <Typography
                  component="a"
                  href={COMMUNITY_LICENSE_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  level="body-sm"
                  sx={{ textDecoration: 'underline' }}
                >
                  Get a license key
                </Typography>
              </Box>
            </Alert>
          ) : (
            <Stack spacing={0.5}>
              <Typography level="body-sm" textColor="text.tertiary">
                {subscription ? 'Pro subscription' : 'Lifetime license'}
                {status?.licensee ? ` — ${status.licensee}` : ''}
                {status?.maxPrinters != null
                  ? `. Covers ${status.maxPrinters} printer${status.maxPrinters === 1 ? '' : 's'}.`
                  : '. Unlimited printers.'}
              </Typography>
              {subscription && status?.expiresAt != null ? (
                <Typography level="body-xs" textColor="text.tertiary">
                  {`Renews automatically — this key is valid through ${formatDate(status.expiresAt)} and refreshes itself daily. Nothing to re-enter.`}
                </Typography>
              ) : null}
              {!subscription && status?.updatesUntil != null ? (
                <Typography level="body-xs" textColor="text.tertiary">
                  {status.updatesExpired
                    ? `Updates & priority support ended ${formatDate(status.updatesUntil)}. This build keeps running; renew to install newer releases.`
                    : `Updates & priority support until ${formatDate(status.updatesUntil)}.`}
                </Typography>
              ) : null}
            </Stack>
          )}

          {error ? <Alert color="danger" variant="soft">{error}</Alert> : null}

          {canManage ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-end' }}>
              <Input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="Paste a license key (PSL1…)"
                sx={{ flex: 1 }}
              />
              <Button
                onClick={() => saveMutation.mutate(key.trim())}
                disabled={!key.trim() || saveMutation.isPending}
                loading={saveMutation.isPending}
              >
                Save
              </Button>
              {status?.valid || isExpired ? (
                <Button variant="outlined" color="danger" onClick={() => removeMutation.mutate()} loading={removeMutation.isPending}>
                  Remove
                </Button>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  )
}
