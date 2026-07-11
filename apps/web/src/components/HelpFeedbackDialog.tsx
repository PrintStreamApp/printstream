/**
 * "Help & feedback" dialog: starts a support conversation with the PrintStream
 * team (feedback, bug report, or question), available to every signed-in user.
 * On the hosted deployment it opens a two-way conversation via
 * `POST /api/support/conversations` — with markdown support and optional file
 * attachments — and the `help.conversations` plugin slot below the form lists
 * the user's existing conversations so replies are readable from the same
 * footer button (the Account → Messages composer passes
 * `showConversations={false}` because that page already shows the list).
 * Self-hosted installs cannot reach the platform, so the same form composes a
 * prefilled email to `SUPPORT_CONTACT_EMAIL` in the user's mail app instead.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Box, Button, DialogTitle, FormControl, FormHelperText, FormLabel, Radio, RadioGroup, Stack, Textarea, Typography } from '@mui/joy'
import { SUPPORT_CONTACT_EMAIL, type CreateSupportConversationRequest } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { toast } from '../lib/toast'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { useSupportAttachmentDrafts } from '../hooks/useSupportAttachmentDrafts'
import { useSupportImagePaste } from '../hooks/useSupportImagePaste'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { SupportAttachmentsField } from './SupportAttachmentsField'

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

const COMPOSE_FORM_ID = 'help-feedback-compose'

export function HelpFeedbackDialog({
  onClose,
  showConversations = true
}: {
  onClose: () => void
  /** Hide the `help.conversations` slot when the host page already lists them. */
  showConversations?: boolean
}) {
  const { selfHosted } = useRuntimePolicy()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<HelpKind>('question')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const attachmentDrafts = useSupportAttachmentDrafts('/api/support/attachments')
  const handleImagePaste = useSupportImagePaste(attachmentDrafts, setMessage)
  const canSubmit = message.trim().length > 0 && !attachmentDrafts.uploading

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
        body: {
          kind,
          message: message.trim(),
          pageUrl: window.location.pathname,
          attachmentIds: attachmentDrafts.attachmentIds
        }
      })
      // Refresh every mounted conversation list (this dialog's slot and
      // Account → Messages) so the new thread appears without a reload.
      void queryClient.invalidateQueries({ queryKey: ['support'] })
      toast.success('Message sent. Replies show up under Help & feedback and on your Account page.')
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
      <ScrollableModalDialog sx={{ maxWidth: 520 }}>
        <DialogTitle>Help &amp; feedback</DialogTitle>
        <Typography level="body-sm" textColor="text.tertiary">
          {selfHosted
            ? `Opens an email draft to ${SUPPORT_CONTACT_EMAIL} in your mail app.`
            : 'Starts a conversation with the PrintStream team. We reply here and under Messages on your Account page.'}
        </Typography>
        <ScrollableDialogBody>
          <Stack spacing={1.5} sx={{ pt: 0.5 }}>
            <Box
              component="form"
              id={COMPOSE_FORM_ID}
              onSubmit={handleSubmit}
              sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
            >
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
                  slotProps={selfHosted ? undefined : { textarea: { onPaste: handleImagePaste } }}
                />
                {!selfHosted && <FormHelperText>Markdown is supported. Paste images to attach them.</FormHelperText>}
              </FormControl>
              {/* Self-hosted submissions become a mailto: draft, which cannot carry uploads. */}
              {!selfHosted && <SupportAttachmentsField drafts={attachmentDrafts} disabled={submitting} />}
              {error && <Typography color="danger" level="body-sm">{error}</Typography>}
            </Box>
            {showConversations && <StaticPluginSlot name="help.conversations" />}
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 0.5 }}>
          <Button type="button" variant="plain" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={COMPOSE_FORM_ID} loading={submitting} disabled={!canSubmit}>
            {selfHosted ? 'Open email draft' : 'Send'}
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
