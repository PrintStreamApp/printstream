/**
 * "Help & feedback" dialog: starts a support conversation with the PrintStream
 * team (feedback, bug report, or question), available to signed-in users and
 * the implicit administrator of an auth-disabled self-hosted install.
 * On the hosted deployment it opens a two-way conversation via
 * `POST /api/support/conversations`, with markdown support and optional file
 * attachments, and the `help.conversations` plugin slot below the form lists
 * the user's existing conversations so replies are readable from the same
 * footer button (the Account → Messages composer passes
 * `showConversations={false}` because that page already shows the list).
 * After a successful send, the composer stays mounted and opens the new
 * conversation so delivery is visible in context and the user can continue
 * the thread immediately.
 * Self-hosted installs use the opt-out cloud-connection relay only while their
 * commercial support window is current. Email remains the fallback when that
 * connection is disabled, ineligible, or unreachable.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Box, Button, DialogTitle, FormControl, FormHelperText, FormLabel, Radio, RadioGroup, Stack, Textarea, Typography } from '@mui/joy'
import {
  SUPPORT_CONTACT_EMAIL,
  type CreateSupportConversationRequest,
  type CreateSupportConversationResponse,
  type LicenseStatusResponse
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { PluginSlot } from '../plugin/PluginSlot'
import { usePluginSlots } from '../plugin/usePluginSlots'
import { resolveHelpSupportTransport } from '../lib/helpSupport'
import { useSupportAttachmentDrafts } from '../hooks/useSupportAttachmentDrafts'
import { useSupportImagePaste } from '../hooks/useSupportImagePaste'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { SupportAttachmentsField } from './SupportAttachmentsField'
import { ConversationDialog } from './support/ConversationDialog'

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
  const conversationSlots = usePluginSlots('help.conversations')
  const cloudConnectionActive = conversationSlots.some((slot) => slot.pluginName === 'cloud-connection')
  const licenseQuery = useQuery({
    queryKey: ['license'],
    queryFn: ({ signal }) => apiFetch<LicenseStatusResponse>('/api/license', { signal }),
    enabled: selfHosted && cloudConnectionActive,
    staleTime: 5 * 60_000,
    meta: { suppressGlobalErrorToast: true }
  })
  const selfHostedEligible = Boolean(
    licenseQuery.data?.status.valid
    && licenseQuery.data.status.edition === 'commercial'
    && !licenseQuery.data.status.updatesExpired
  )
  const checkingSupport = selfHosted && cloudConnectionActive && licenseQuery.isPending
  const supportTransport = resolveHelpSupportTransport(
    selfHosted,
    conversationSlots.map((slot) => slot.pluginName),
    selfHostedEligible
  )
  const inAppSupport = supportTransport.inApp
  const supportBase = supportTransport.base
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<HelpKind>('question')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [openConversationId, setOpenConversationId] = useState<string | null>(null)
  const attachmentDrafts = useSupportAttachmentDrafts(`${supportBase}/attachments`)
  const handleImagePaste = useSupportImagePaste(attachmentDrafts, setMessage)
  const canSubmit = message.trim().length > 0 && !attachmentDrafts.uploading && !checkingSupport

  /** Open the composed message in the user's mail client. Mailto cannot carry attachments. */
  const openEmailDraft = () => {
    const subject = `PrintStream ${KIND_LABELS[kind].toLowerCase()}`
    window.location.href = `mailto:${SUPPORT_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message.trim())}`
    onClose()
  }

  const submit = async () => {
    if (!inAppSupport) {
      openEmailDraft()
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const response = await apiFetch<CreateSupportConversationResponse>(`${supportBase}/conversations`, {
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
      setMessage('')
      attachmentDrafts.reset()
      setSubmitting(false)
      setOpenConversationId(response.conversationId)
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

  let transportDescription: string
  if (checkingSupport) {
    transportDescription = 'Checking whether this license includes in-app support.'
  } else if (!inAppSupport) {
    transportDescription = `Opens an email draft to ${SUPPORT_CONTACT_EMAIL} in your mail app.`
  } else if (selfHosted) {
    transportDescription = 'Sends this message, attachments, workspace name and identifier, current page, app build, browser details, license key, and installation ID to PrintStream Cloud. We reply here and email the license owner if the reply is not read within five minutes.'
  } else {
    transportDescription = 'Starts a conversation with the PrintStream team. We reply here and under Messages on your Account page.'
  }

  return (
    <>
      <Modal open onClose={onClose}>
        <ScrollableModalDialog sx={{ maxWidth: 520 }}>
          <DialogTitle>Help &amp; feedback</DialogTitle>
          <Typography level="body-sm" textColor="text.tertiary">
            {transportDescription}
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
                    slotProps={!inAppSupport ? undefined : { textarea: { onPaste: handleImagePaste } }}
                  />
                  {inAppSupport && <FormHelperText>Markdown is supported. Paste images to attach them.</FormHelperText>}
                </FormControl>
                {/* Self-hosted submissions become a mailto: draft, which cannot carry uploads. */}
                {inAppSupport && <SupportAttachmentsField drafts={attachmentDrafts} disabled={submitting} />}
                {error ? (
                  <Stack spacing={0.5} alignItems="flex-start">
                    <Typography color="danger" level="body-sm">{error}</Typography>
                    {selfHosted ? (
                      <Button size="sm" variant="plain" color="neutral" onClick={openEmailDraft}>
                        Open email draft instead
                      </Button>
                    ) : null}
                  </Stack>
                ) : null}
              </Box>
              {showConversations && inAppSupport ? <PluginSlot name="help.conversations" /> : null}
            </Stack>
          </ScrollableDialogBody>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 0.5 }}>
            <Button type="button" variant="plain" onClick={onClose}>Cancel</Button>
            <Button type="submit" form={COMPOSE_FORM_ID} loading={submitting || checkingSupport} disabled={!canSubmit}>
              {inAppSupport ? 'Send' : 'Open email draft'}
            </Button>
          </Stack>
        </ScrollableModalDialog>
      </Modal>
      {openConversationId ? (
        <ConversationDialog
          conversationId={openConversationId}
          viewer="user"
          userBase={supportBase}
          onClose={() => setOpenConversationId(null)}
        />
      ) : null}
    </>
  )
}
