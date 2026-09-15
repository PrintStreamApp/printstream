/**
 * Support conversation thread dialog, shared by both sides of the
 * conversation: workspace users open it from Account → Messages
 * (`viewer="user"`), platform admins from the platform Messages inbox
 * (`viewer="platform"`). Shows the message thread (markdown bodies plus
 * attachment thumbnails/downloads) with a pinned reply composer that supports
 * file attachments, marks the thread read on open, and (platform only)
 * exposes the claim/release/take-over and resolve/reopen actions plus the
 * opening message's submission context.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Box, Button, Chip, DialogTitle, Divider, Sheet, Stack, Textarea, Tooltip, Typography } from '@mui/joy'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import SupportAgentRoundedIcon from '@mui/icons-material/SupportAgentRounded'
import type {
  SupportConversationDetailResponse,
  SupportMessage,
  SupportMessageSide
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { buildApiUrl } from '../../lib/apiUrl'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { useNotificationTagVisibilityClaim } from '../../lib/notificationTagVisibility'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { Markdown } from '../Markdown'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { SupportAttachmentsField } from '../SupportAttachmentsField'
import { useSupportAttachmentDrafts } from '../../hooks/useSupportAttachmentDrafts'
import { useSupportImagePaste } from '../../hooks/useSupportImagePaste'
import { MessageAttachments } from './MessageAttachments'
import { supportConversationAttribution, supportMessageSenderName } from './conversationAttribution'
import { formatMessageTime, SUPPORT_KIND_META } from './supportKinds'
import { ListSkeleton } from '../ListSkeleton'

/**
 * Message bodies reference pasted images as viewer-neutral `attachment:<id>`
 * URIs (the two sides download through different routes); resolve them
 * against this viewer's base for inline rendering.
 */
function attachmentUriResolver(base: string) {
  return (uri: string) => uri.startsWith('attachment:')
    ? buildApiUrl(`${base}/attachments/${encodeURIComponent(uri.slice('attachment:'.length))}`)
    : null
}

export function ConversationDialog({
  conversationId,
  viewer,
  userBase = '/api/support',
  onClose
}: {
  conversationId: string
  viewer: SupportMessageSide
  /** User-side API root; self-hosted support is relayed through its plugin. */
  userBase?: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const base = viewer === 'platform' ? '/api/platform/support' : userBase
  // While this thread is open and focused, its push notifications are noise;
  // the service worker checks this claim before showing one.
  useNotificationTagVisibilityClaim(`support:${conversationId}`)
  const [draft, setDraft] = useState('')
  const attachmentDrafts = useSupportAttachmentDrafts(`${base}/attachments`)
  const handleImagePaste = useSupportImagePaste(attachmentDrafts, setDraft)

  const detailQuery = useQuery<SupportConversationDetailResponse>({
    queryKey: ['support', viewer, 'conversation', conversationId, base],
    queryFn: ({ signal }) => apiFetch<SupportConversationDetailResponse>(`${base}/conversations/${conversationId}`, { signal })
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['support'] })
  }

  const markReadMutation = useMutation({
    mutationFn: () => apiFetch(`${base}/conversations/${conversationId}/read`, { method: 'POST' }),
    onSuccess: invalidate
  })

  const conversation = detailQuery.data?.conversation
  const unreadCount = conversation?.unreadCount ?? 0
  useEffect(() => {
    if (unreadCount > 0 && !markReadMutation.isPending) {
      markReadMutation.mutate()
    }
    // markReadMutation identity is unstable by design; keying on unreadCount is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadCount, conversationId])

  const replyMutation = useMutation({
    mutationFn: (message: string) =>
      apiFetch(`${base}/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: { message, attachmentIds: attachmentDrafts.attachmentIds }
      }),
    onSuccess: () => {
      setDraft('')
      attachmentDrafts.reset()
      invalidate()
    }
  })

  const resolveMutation = useMutation({
    mutationFn: (resolved: boolean) =>
      apiFetch(`${base}/conversations/${conversationId}`, { method: 'PATCH', body: { resolved } }),
    onSuccess: invalidate
  })

  const claimMutation = useMutation({
    mutationFn: (claim: boolean) =>
      apiFetch(`${base}/conversations/${conversationId}/claim`, { method: claim ? 'POST' : 'DELETE' }),
    onSuccess: invalidate
  })

  const handleSend = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (draft.trim().length === 0 || replyMutation.isPending || attachmentDrafts.uploading) return
    replyMutation.mutate(draft.trim())
  }

  const resolved = conversation?.status === 'resolved'
  const kindMeta = conversation ? SUPPORT_KIND_META[conversation.kind] : null

  // Claiming is a platform-side concept: who on the team is handling this
  // thread. Unclaimed threads notify every operator; claimed ones only the
  // assignee, so the header makes the current state and takeover explicit.
  const authBootstrapQuery = useAuthBootstrapQuery({ enabled: viewer === 'platform' })
  const currentUserId = authBootstrapQuery.data?.actor.userId ?? null
  const assignedToMe = conversation != null
    && conversation.assignedToUserId !== null
    && conversation.assignedToUserId === currentUserId

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 640 }}>
        <DialogTitle>
          <Stack spacing={0.5} sx={{ minWidth: 0, width: '100%' }}>
            <Stack direction="row" spacing={1} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
              {kindMeta && (
                <Chip size="sm" variant="soft" color={kindMeta.color} startDecorator={kindMeta.icon}>
                  {kindMeta.label}
                </Chip>
              )}
              {resolved && (
                <Chip size="sm" variant="soft" color="success" startDecorator={<CheckCircleRoundedIcon />}>
                  Resolved
                </Chip>
              )}
              {viewer === 'platform' && conversation && (
                <Chip
                  size="sm"
                  variant="soft"
                  color={conversation.assignedToUserId ? 'primary' : 'warning'}
                  startDecorator={<SupportAgentRoundedIcon />}
                >
                  {conversation.assignedToUserId
                    ? `Handled by ${assignedToMe ? 'you' : conversation.assignedToName ?? 'an operator'}`
                    : 'Unclaimed'}
                </Chip>
              )}
              {viewer === 'platform' && conversation && (
                <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    loading={claimMutation.isPending}
                    onClick={() => claimMutation.mutate(!assignedToMe)}
                  >
                    {assignedToMe ? 'Release' : conversation.assignedToUserId ? 'Take over' : 'Claim'}
                  </Button>
                  <Button
                    size="sm"
                    variant={resolved ? 'plain' : 'outlined'}
                    color={resolved ? 'neutral' : 'success'}
                    loading={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate(!resolved)}
                  >
                    {resolved ? 'Reopen' : 'Mark resolved'}
                  </Button>
                </Stack>
              )}
            </Stack>
            <Typography level="title-lg" sx={{ overflowWrap: 'anywhere' }}>
              {conversation?.subject ?? 'Conversation'}
            </Typography>
            {viewer === 'platform' && conversation && (
              <Typography level="body-xs" textColor="text.tertiary">
                {supportConversationAttribution(conversation)}
              </Typography>
            )}
          </Stack>
        </DialogTitle>
        <ScrollableDialogBody pinToBottom>
          {detailQuery.isPending ? (
            <ListSkeleton rows={2} />
          ) : detailQuery.isError || !detailQuery.data ? (
            <Typography level="body-sm" color="danger">This conversation could not be loaded.</Typography>
          ) : (
            <Stack spacing={1.5} sx={{ py: 0.5 }}>
              {detailQuery.data.messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  senderName={supportMessageSenderName(detailQuery.data.conversation, message)}
                  viewer={viewer}
                  base={base}
                />
              ))}
            </Stack>
          )}
        </ScrollableDialogBody>
        <Divider />
        <Box component="form" onSubmit={handleSend} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Textarea
            value={draft}
            minRows={2}
            maxRows={6}
            placeholder={viewer === 'platform' ? 'Reply to the user…' : 'Reply to the PrintStream team…'}
            onChange={(event) => setDraft(event.target.value)}
            slotProps={{ textarea: { onPaste: handleImagePaste } }}
          />
          <Stack direction="row" spacing={1} useFlexGap alignItems="center" justifyContent="space-between" sx={{ flexWrap: 'wrap' }}>
            <SupportAttachmentsField drafts={attachmentDrafts} disabled={replyMutation.isPending} />
            <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
              <Button type="button" variant="plain" color="neutral" onClick={onClose}>Close</Button>
              <Button
                type="submit"
                loading={replyMutation.isPending}
                disabled={draft.trim().length === 0 || attachmentDrafts.uploading}
              >
                Send
              </Button>
            </Stack>
          </Stack>
        </Box>
      </ScrollableModalDialog>
    </Modal>
  )
}

function MessageBubble({
  message,
  senderName,
  viewer,
  base
}: {
  message: SupportMessage
  senderName: string
  viewer: SupportMessageSide
  base: string
}) {
  const own = message.side === viewer
  const context = [
    message.pageUrl ? { label: 'Page', value: message.pageUrl } : null,
    message.appVersion ? { label: 'Build', value: message.appVersion } : null,
    message.userAgent ? { label: 'Browser', value: message.userAgent } : null
  ].filter((part): part is { label: string; value: string } => part !== null)

  return (
    <Stack spacing={0.25} sx={{ alignItems: own ? 'flex-end' : 'flex-start' }}>
      <Typography level="body-xs" textColor="text.tertiary">
        {senderName} · {formatMessageTime(message.createdAt)}
      </Typography>
      <Sheet
        variant={own ? 'solid' : 'soft'}
        color={own ? 'primary' : 'neutral'}
        sx={{ px: 1.25, py: 0.75, borderRadius: 'lg', maxWidth: '85%', ...(own ? { color: 'common.white' } : {}) }}
      >
        <Markdown colorInherit={own} resolveUri={attachmentUriResolver(base)}>{message.body}</Markdown>
      </Sheet>
      <MessageAttachments
        attachments={message.attachments}
        base={base}
        align={own ? 'flex-end' : 'flex-start'}
        inlineAttachmentIds={new Set(message.attachments
          .filter((attachment) => message.body.includes(`attachment:${attachment.id}`))
          .map((attachment) => attachment.id))}
      />
      {viewer === 'platform' && context.length > 0 && (
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', maxWidth: '85%', justifyContent: own ? 'flex-end' : 'flex-start' }}>
          {context.map((entry) => (
            <ContextChip key={entry.label} label={entry.label} value={entry.value} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

/**
 * Submission-context detail as a compact chip: truncated at rest, the full
 * value on hover (tooltip), and click-to-expand in place for touch screens.
 */
function ContextChip({ label, value }: { label: string; value: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <Tooltip title={`${label}: ${value}`} variant="soft" placement="top" sx={{ maxWidth: 420, overflowWrap: 'anywhere' }}>
      <Chip
        size="sm"
        variant="outlined"
        color="neutral"
        onClick={() => setExpanded((current) => !current)}
        sx={[
          { color: 'neutral.500', fontSize: 'xs' },
          expanded
            ? { maxWidth: '100%', height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', overflowWrap: 'anywhere' } }
            : { maxWidth: 200, '& .MuiChip-label': { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }
        ]}
      >
        {label}: {value}
      </Chip>
    </Tooltip>
  )
}
