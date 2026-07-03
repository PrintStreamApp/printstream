/**
 * "Help & feedback" dialog: starts a support conversation with the PrintStream
 * team (feedback, bug report, or question), available to every signed-in user.
 * On the hosted deployment it opens a two-way conversation via
 * `POST /api/support/conversations` — replies land in Account → Messages.
 * Self-hosted installs cannot reach the platform, so the same form composes a
 * prefilled email to `SUPPORT_CONTACT_EMAIL` in the user's mail app instead.
 */
import { useState } from 'react'
import { Box, Button, FormControl, FormLabel, ModalDialog, Radio, RadioGroup, Stack, Textarea, Typography } from '@mui/joy'
import { SUPPORT_CONTACT_EMAIL, type CreateSupportConversationRequest } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { toast } from '../lib/toast'
import { BackAwareModal as Modal } from './BackAwareModal'

type HelpKind = CreateSupportConversationRequest['kind']

const KIND_LABELS: Record<HelpKind, string> = {
  feedback: 'Feedback',
  bug: 'Bug report',
  question: 'Question'
}

const KIND_PLACEHOLDERS: Record<HelpKind, string> = {
  feedback: 'What would make PrintStream better for you?',
  bug: 'What went wrong? What did you expect to happen?',
  question: 'What can we help you with?'
}

export function HelpFeedbackDialog({ onClose }: { onClose: () => void }) {
  const { selfHosted } = useRuntimePolicy()
  const [kind, setKind] = useState<HelpKind>('question')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const canSubmit = message.trim().length > 0

  const submit = async () => {
    if (selfHosted) {
      // Self-hosted installs cannot reach the platform — hand the message to
      // the user's mail app addressed to the project inbox instead.
      const subject = `PrintStream ${KIND_LABELS[kind].toLowerCase()}`
      window.location.href = `mailto:${SUPPORT_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message.trim())}`
      onClose()
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch('/api/support/conversations', {
        method: 'POST',
        body: { kind, message: message.trim(), pageUrl: window.location.pathname }
      })
      toast.success('Message sent — replies show up under Messages on your Account page.')
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || submitting) return
    void submit()
  }

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Stack spacing={0.5}>
            <Typography level="h4">Help &amp; feedback</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              {selfHosted
                ? `Opens an email draft to ${SUPPORT_CONTACT_EMAIL} in your mail app.`
                : 'Starts a conversation with the PrintStream team — we reply under Messages on your Account page.'}
            </Typography>
          </Stack>
          <FormControl>
            <FormLabel>What kind of message is this?</FormLabel>
            <RadioGroup
              orientation="horizontal"
              value={kind}
              onChange={(event) => setKind(event.target.value as HelpKind)}
              sx={{ gap: 2, flexWrap: 'wrap' }}
            >
              <Radio value="question" label={KIND_LABELS.question} />
              <Radio value="feedback" label={KIND_LABELS.feedback} />
              <Radio value="bug" label={KIND_LABELS.bug} />
            </RadioGroup>
          </FormControl>
          <FormControl>
            <FormLabel>Message</FormLabel>
            <Textarea
              value={message}
              autoFocus
              minRows={4}
              maxRows={10}
              placeholder={KIND_PLACEHOLDERS[kind]}
              onChange={(event) => setMessage(event.target.value)}
            />
          </FormControl>
          {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 0.5 }}>
            <Button type="button" variant="plain" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={submitting} disabled={!canSubmit}>
              {selfHosted ? 'Open email draft' : 'Send'}
            </Button>
          </Stack>
        </Box>
      </ModalDialog>
    </Modal>
  )
}
