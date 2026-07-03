/**
 * Self-hosted license settings (core/public). Shows the installed license status,
 * a non-commercial notice for community/unlicensed installs, and (with
 * settings.manage) lets an operator paste or remove a license key. Rendered only
 * in self-hosted mode; the multi-tenant cloud licenses via subscriptions.
 */
import { Alert, Box, Button, Card, CardContent, Chip, Input, Stack, Typography } from '@mui/joy'
import { extractErrorMessage } from '@printstream/shared'
import type { LicenseStatusResponse } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../lib/apiClient'
import { COMMUNITY_LICENSE_URL } from '../lib/licenseUrls'

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
  const isCommercial = status?.valid && status.edition === 'commercial'
  const isCommunity = status?.valid && status.edition === 'community'

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography level="title-md">License</Typography>
            {status?.valid ? (
              <Chip size="sm" variant="soft" color={isCommercial ? 'primary' : 'neutral'}>
                {isCommercial ? 'Commercial' : 'Community'}
              </Chip>
            ) : (
              <Chip size="sm" variant="soft" color="warning">Unlicensed</Chip>
            )}
          </Stack>

          {!isCommercial ? (
            <Alert color="warning" variant="soft">
              {isNative
                ? (isCommunity
                    ? 'A community key is installed, but the native app requires a commercial license — community keys cover the Docker build only.'
                    : 'The native app requires a commercial license. Enter one below to keep full functionality past the evaluation period.')
                : isCommunity
                  ? 'Community edition — licensed for personal, non-commercial use only. A commercial license is required for business use.'
                  : 'This install is unlicensed. It is free for personal, non-commercial use — add a community key below, or a commercial license for business use.'}
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
            <Typography level="body-sm" textColor="text.tertiary">
              Commercial license active{status?.licensee ? ` — ${status.licensee}` : ''}
              {status?.updatesUntil ? `. Updates & support until ${new Date(status.updatesUntil * 1000).toLocaleDateString()}.` : '.'}
              {status?.updatesExpired ? ' Updates have lapsed — renew to keep receiving them.' : ''}
            </Typography>
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
              {status?.valid ? (
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
