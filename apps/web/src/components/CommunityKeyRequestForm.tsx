/**
 * Getting the free community key without leaving the install.
 *
 * Enforcement reaches the Docker/OSS build, and the only route to the free key
 * it accepts used to run through a signed-in account on the vendor's site —
 * asking someone who self-hosts, often precisely to avoid a vendor account, to
 * register in order to keep printing. This asks for an address and nothing
 * else.
 *
 * Shown only where it helps: an install with no valid key, to an operator who
 * could act on one. A licensed install has nothing to request, and a member who
 * cannot install a key cannot use one either.
 *
 * The request goes to the SERVER, which relays it — the browser may be on a
 * segment with no route out while the machine running PrintStream is not. The
 * paste box above stays for exactly that case: an install with no egress, whose
 * operator fetches a key from another device.
 *
 * Counterpart: `apps/api/src/routes/license.ts` (`POST /api/license/community-request`).
 */
import { Alert, Button, Checkbox, Input, Stack, Typography } from '@mui/joy'
import { extractErrorMessage } from '@printstream/shared'
import type { CommunityLicenseResponse } from '@printstream/shared'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../lib/apiClient'

export function CommunityKeyRequestForm() {
  const [email, setEmail] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const request = useMutation({
    mutationFn: (value: string) => apiFetch<CommunityLicenseResponse>('/api/license/community-request', {
      method: 'POST',
      body: { email: value, agreedToTerms: true }
    }),
    onSuccess: (_data, value) => setSentTo(value)
  })

  if (sentTo) {
    return (
      <Alert color="success" variant="soft">
        <Stack spacing={0.5}>
          <Typography level="body-sm">{`Sent to ${sentTo}.`}</Typography>
          <Typography level="body-xs" textColor="text.tertiary">
            Paste the key above when it arrives. We also kept it on an account for that address, so
            you can sign in at printstream.app later to find it again or upgrade — there is no
            password to set and nothing else to do.
          </Typography>
        </Stack>
      </Alert>
    )
  }

  const trimmed = email.trim()
  return (
    <Stack spacing={1}>
      <Typography level="body-sm" textColor="text.tertiary">
        No key yet? A community key is free and perpetual for personal, non-commercial use. It never
        phones home, so this install keeps working offline.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-end' }}>
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          sx={{ flex: 1 }}
        />
        <Button
          variant="outlined"
          onClick={() => request.mutate(trimmed)}
          disabled={!trimmed || !agreed || request.isPending}
          loading={request.isPending}
        >
          Email me a key
        </Button>
      </Stack>
      {/* The same agreement the vendor's own form takes, asked here because
          this is where the person is. The API requires it too — a client that
          forgets it must fail rather than agree on someone's behalf. */}
      <Checkbox
        size="sm"
        checked={agreed}
        onChange={(event) => setAgreed(event.target.checked)}
        label="I will use this install for personal, non-commercial purposes."
      />
      {request.isError ? (
        <Alert color="danger" variant="soft">
          {extractErrorMessage(request.error, 'Could not request a key.')}
        </Alert>
      ) : null}
    </Stack>
  )
}
