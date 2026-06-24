/**
 * SMTP server settings panel (self-hosted). Configures the operator's mail
 * server that backs email-based features. The password is write-only — the API
 * never returns it; leaving the field blank keeps the stored value.
 */
import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  FormControl,
  FormLabel,
  Input,
  Stack,
  Typography
} from '@mui/joy'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import SendRoundedIcon from '@mui/icons-material/SendRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'
import { extractErrorMessage } from '@printstream/shared'

interface SmtpStatus {
  configured: boolean
  host: string | null
  port: number | string | null
  secure: boolean
  username: string | null
  fromEmail: string | null
  fromName: string | null
  hasPassword: boolean
}

const QUERY_KEY = ['plugin-settings', 'email-smtp']

export function SmtpSettingsPanel() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch<SmtpStatus>('/api/plugins/email-smtp')
  })

  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [secure, setSecure] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [testTo, setTestTo] = useState('')

  useEffect(() => {
    const data = query.data
    if (!data) return
    setHost(data.host ?? '')
    setPort(data.port != null ? String(data.port) : '')
    setSecure(data.secure)
    setUsername(data.username ?? '')
    setFromEmail(data.fromEmail ?? '')
    setFromName(data.fromName ?? '')
  }, [query.data])

  const save = useMutation({
    mutationFn: () => apiFetch<{ configured: boolean }>('/api/plugins/email-smtp/config', {
      method: 'PUT',
      body: {
        host: host.trim(),
        port: port.trim() ? Number(port.trim()) : undefined,
        secure,
        username: username.trim() || null,
        // Only send a password when the operator typed one; blank keeps the stored value.
        ...(password ? { password } : {}),
        fromEmail: fromEmail.trim(),
        fromName: fromName.trim() || null
      }
    }),
    onSuccess: async () => {
      setPassword('')
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    }
  })

  const sendTest = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; error?: string }>('/api/plugins/email-smtp/test', {
      method: 'POST',
      body: { to: testTo.trim() }
    })
  })

  const hasPassword = Boolean(query.data?.hasPassword)
  const saveError = save.error ? extractErrorMessage(save.error) : null
  const testResult = sendTest.data
  const testError = sendTest.error ? extractErrorMessage(sendTest.error) : (testResult && !testResult.ok ? testResult.error ?? 'SMTP delivery failed.' : null)

  return (
    <Stack spacing={1.25}>
      <Typography level="body-sm" textColor="text.tertiary">
        {query.data?.configured
          ? 'SMTP is configured. Email-based features can deliver through your mail server.'
          : 'Point PrintStream at your SMTP server to enable email notifications.'}
      </Typography>

      <FormControl required>
        <FormLabel>SMTP host</FormLabel>
        <Input value={host} onChange={(event) => setHost(event.target.value)} placeholder="smtp.example.com" />
      </FormControl>

      <Stack direction="row" spacing={1}>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Port</FormLabel>
          <Input value={port} onChange={(event) => setPort(event.target.value)} placeholder={secure ? '465' : '587'} />
        </FormControl>
        <FormControl sx={{ justifyContent: 'flex-end' }}>
          <Checkbox label="Use TLS (SMTPS)" checked={secure} onChange={(event) => setSecure(event.target.checked)} />
        </FormControl>
      </Stack>

      <FormControl>
        <FormLabel>Username</FormLabel>
        <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="(optional)" autoComplete="off" />
      </FormControl>

      <FormControl>
        <FormLabel>Password</FormLabel>
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={hasPassword ? 'Stored — leave blank to keep' : '(optional)'}
          autoComplete="new-password"
        />
      </FormControl>

      <FormControl required>
        <FormLabel>From address</FormLabel>
        <Input type="email" value={fromEmail} onChange={(event) => setFromEmail(event.target.value)} placeholder="printstream@example.com" />
      </FormControl>

      <FormControl>
        <FormLabel>From name</FormLabel>
        <Input value={fromName} onChange={(event) => setFromName(event.target.value)} placeholder="PrintStream" />
      </FormControl>

      {saveError && (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{saveError}</Alert>
      )}

      <Stack direction="row" spacing={1}>
        <Button
          size="sm"
          loading={save.isPending}
          startDecorator={<SaveRoundedIcon />}
          disabled={!host.trim() || !fromEmail.trim()}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </Stack>

      {query.data?.configured && (
        <>
          <Typography level="title-sm" sx={{ mt: 1 }}>Send a test email</Typography>
          {sendTest.isSuccess && testResult?.ok && (
            <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>Test email sent.</Alert>
          )}
          {testError && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{testError}</Alert>
          )}
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <FormControl sx={{ flex: 1 }}>
              <FormLabel>Recipient</FormLabel>
              <Input type="email" value={testTo} onChange={(event) => setTestTo(event.target.value)} placeholder="you@example.com" />
            </FormControl>
            <Button
              size="sm"
              variant="soft"
              loading={sendTest.isPending}
              startDecorator={<SendRoundedIcon />}
              disabled={!testTo.trim()}
              onClick={() => sendTest.mutate()}
            >
              Send test
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  )
}
