/**
 * `help.conversations` slot content: the user's existing support
 * conversations rendered below the compose form in the core Help & feedback
 * dialog, so replies are reachable from the same footer button that starts a
 * conversation. Renders nothing while loading, on error (e.g. signed out), or
 * when the user has no conversations yet, leaving the dialog a pure composer.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Divider, Stack, Typography } from '@mui/joy'
import type { SupportConversationListResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { ConversationDialog } from './ConversationDialog'
import { ConversationRow } from './ConversationRow'

export function HelpDialogConversations({ base = '/api/support' }: { base?: string }) {
  const [openConversationId, setOpenConversationId] = useState<string | null>(null)

  const conversationsQuery = useQuery<SupportConversationListResponse>({
    queryKey: ['support', 'user', 'conversations', base],
    queryFn: ({ signal }) => apiFetch<SupportConversationListResponse>(`${base}/conversations`, { signal }),
    meta: { suppressGlobalErrorToast: true }
  })

  const conversations = conversationsQuery.data?.conversations ?? []
  if (conversations.length === 0) return null

  return (
    <Stack spacing={1}>
      <Divider />
      <Typography level="title-sm">Your conversations</Typography>
      <Stack spacing={1}>
        {conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            onOpen={() => setOpenConversationId(conversation.id)}
          />
        ))}
      </Stack>
      {openConversationId && (
        <ConversationDialog
          conversationId={openConversationId}
          viewer="user"
          userBase={base}
          onClose={() => setOpenConversationId(null)}
        />
      )}
    </Stack>
  )
}
