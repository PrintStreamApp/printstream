/**
 * One support conversation as a clickable row (settings-overview-card
 * pattern): kind/unread/resolved chips, timestamp, subject, and last-message
 * preview. Shared by Account → Messages and the Help & feedback dialog's
 * `help.conversations` slot so a conversation reads the same in both places.
 */
import { Card, Chip, Stack, Typography } from '@mui/joy'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import type { SupportConversation } from '@printstream/shared'
import { formatConversationTime, SUPPORT_KIND_META } from './supportKinds'

export function ConversationRow({ conversation, onOpen }: { conversation: SupportConversation; onOpen: () => void }) {
  const kindMeta = SUPPORT_KIND_META[conversation.kind]
  const hasUnread = conversation.unreadCount > 0

  return (
    // The whole row opens the thread (settings-overview-card pattern).
    <Card
      variant="outlined"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
      sx={{
        gap: 0.5,
        p: 1.5,
        cursor: 'pointer',
        transition: 'background-color 0.2s ease, border-color 0.2s ease',
        '&:hover': {
          backgroundColor: 'background.level1',
          borderColor: 'primary.softColor'
        },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'focusVisible',
          outlineOffset: '2px'
        }
      }}
    >
      <Stack direction="row" spacing={1} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
        <Chip size="sm" variant="soft" color={kindMeta.color} startDecorator={kindMeta.icon}>
          {kindMeta.label}
        </Chip>
        {hasUnread && (
          <Chip size="sm" variant="solid" color="primary">
            {conversation.unreadCount} new
          </Chip>
        )}
        {conversation.status === 'resolved' && (
          <Chip size="sm" variant="soft" color="success" startDecorator={<CheckCircleRoundedIcon />}>
            Resolved
          </Chip>
        )}
        <Typography level="body-xs" textColor="text.tertiary" sx={{ ml: 'auto' }}>
          {formatConversationTime(conversation.lastMessageAt)}
        </Typography>
      </Stack>
      <Typography level={hasUnread ? 'title-sm' : 'body-sm'} sx={{ overflowWrap: 'anywhere' }}>
        {conversation.subject}
      </Typography>
      <Typography level="body-xs" textColor="text.tertiary" noWrap>
        {conversation.lastMessagePreview}
      </Typography>
    </Card>
  )
}
