/**
 * Sign-in flow for a Bambu Lab account.
 *
 * Two legs, because Bambu almost always demands a second factor: the account and
 * password, then either a code it emails or one from the user's authenticator app.
 * Which of the two is asked for is decided by Bambu, not by us: the API reports it
 * back from the first leg, so there is no "which kind of 2FA do you have?" question.
 *
 * The password is sent once, used for that call, and never stored (nor is it kept in
 * component state past the step). Only the issued token is persisted, encrypted, by the
 * API, it never comes back to the browser.
 *
 * Counterpart: `apps/api/src/plugins/bambu-cloud-sync/index.ts` (`/connect`, `/connect/verify`).
 */
import { useState } from 'react'
import { FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy'
import { useMutation } from '@tanstack/react-query'
import { extractErrorMessage } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { FormDialog } from '../../components/FormDialog'

type ConnectStep =
  | { step: 'credentials' }
  | { step: 'emailCode' }
  | { step: 'totp'; tfaKey: string }

interface ConnectResponse {
  status: 'connected' | 'needsEmailCode' | 'needsTotp'
  tfaKey?: string
}

export function BambuCloudConnectDialog({ onClose, onConnected }: {
  onClose: () => void
  onConnected: () => void
}): JSX.Element {
  const [region, setRegion] = useState<'global' | 'china'>('global')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [stage, setStage] = useState<ConnectStep>({ step: 'credentials' })

  const startMutation = useMutation({
    mutationFn: async () => await apiFetch<ConnectResponse>('/api/plugins/bambu-cloud-sync/connect', {
      method: 'POST',
      body: { region, account, password }
    }),
    onSuccess: (result) => {
      // Drop the password the moment it is no longer needed.
      setPassword('')
      if (result.status === 'connected') {
        onConnected()
        return
      }
      setStage(result.status === 'needsTotp' && result.tfaKey
        ? { step: 'totp', tfaKey: result.tfaKey }
        : { step: 'emailCode' })
    }
  })

  const verifyMutation = useMutation({
    mutationFn: async () => await apiFetch('/api/plugins/bambu-cloud-sync/connect/verify', {
      method: 'POST',
      body: {
        region,
        account,
        code,
        ...(stage.step === 'totp' ? { tfaKey: stage.tfaKey } : {})
      }
    }),
    onSuccess: onConnected
  })

  const busy = startMutation.isPending || verifyMutation.isPending
  const error = startMutation.error ?? verifyMutation.error

  if (stage.step === 'credentials') {
    return (
      <FormDialog
        title="Connect a Bambu Lab account"
        description="Signs in to Bambu Lab for pasted MakerWorld links and slicing preset sync. Your printers stay exactly as they are, and the app's separate MakerWorld browser keeps its own website sign-in."
        submitLabel="Continue"
        busy={busy}
        submitDisabled={!account.trim() || !password}
        error={error ? extractErrorMessage(error) : undefined}
        onSubmit={() => startMutation.mutate()}
        onClose={onClose}
      >
        <Stack spacing={2}>
          <FormControl>
            <FormLabel>Region</FormLabel>
            <Select value={region} onChange={(_event, value) => { if (value) setRegion(value) }}>
              <Option value="global">Global (bambulab.com)</Option>
              <Option value="china">China (bambulab.cn)</Option>
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel>Email or account</FormLabel>
            <Input
              value={account}
              autoComplete="username"
              onChange={(event) => setAccount(event.target.value)}
              placeholder="you@example.com"
            />
          </FormControl>
          <FormControl>
            <FormLabel>Password</FormLabel>
            <Input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormControl>
          <Typography level="body-xs" textColor="text.tertiary">
            Your password is used to sign in and is never stored. PrintStream keeps only the access
            token Bambu Lab issues, encrypted.
          </Typography>
        </Stack>
      </FormDialog>
    )
  }

  return (
    <FormDialog
      title="Enter your verification code"
      description={stage.step === 'totp'
        ? 'Enter the current code from your authenticator app.'
        : `Bambu Lab emailed a verification code to ${account}.`}
      submitLabel="Connect"
      busy={busy}
      submitDisabled={!code.trim()}
      error={error ? extractErrorMessage(error) : undefined}
      onSubmit={() => verifyMutation.mutate()}
      onClose={onClose}
    >
      <FormControl>
        <FormLabel>Verification code</FormLabel>
        <Input
          value={code}
          autoComplete="one-time-code"
          inputMode="numeric"
          onChange={(event) => setCode(event.target.value)}
        />
      </FormControl>
    </FormDialog>
  )
}
