/**
 * Account → Messages: the current install user's side of support messaging
 * (`account.support` slot). Lists their conversations with the PrintStream
 * team, opens the thread dialog, and starts new conversations through the
 * shared help dialog (with its embedded conversation list suppressed: the
 * same list is already on this page).
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button, Stack } from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import ForumRoundedIcon from '@mui/icons-material/ForumRounded'
import type { SupportConversationListResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { HelpFeedbackDialog } from '../HelpFeedbackDialog'
import { PageSectionHeading } from '../dashboard/PageSectionHeading'
import { ConversationDialog } from './ConversationDialog'
import { ConversationRow } from './ConversationRow'
import { ListSection } from '../ListSection'

/**
 * Where this is being rendered, which is the only thing its three hosts differ
 * on.
 *
 * One union rather than the two independent booleans it replaced: those could
 * express `standalone && headingShownElsewhere`, a state that means nothing,
 * and they arrived through an untyped plugin-slot `context`, so nothing checked
 * that a host's object matched the props.
 *
 * - `account-section`, one section stacked inside the Account page (the
 *   `account.support` slot). Renders its own `title-lg` heading.
 * - `standalone-page`, its own route, so the heading is lifted to the `h3`
 *   every other top-level view uses. See `AccountSlotView`.
 * - `hosted-section`: the billing scope, whose sections are headed by the
 *   page, so this one renders no heading at all.
 */
export type AccountMessagesPresentation = 'account-section' | 'standalone-page' | 'hosted-section'

export function AccountMessagesSection({
  presentation = 'account-section',
  base = '/api/support'
}: {
  presentation?: AccountMessagesPresentation
  base?: string
}) {
  const standalone = presentation === 'standalone-page'
  const headingShownElsewhere = presentation === 'hosted-section'
  const [openConversationId, setOpenConversationId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)

  // Notification emails deep-link with `?conversation=<id>`: open that thread
  // once, then strip the param so closing the dialog doesn't reopen it.
  const [searchParams, setSearchParams] = useSearchParams()
  const conversationParam = searchParams.get('conversation')
  useEffect(() => {
    if (!conversationParam) return
    setOpenConversationId(conversationParam)
    setSearchParams((params) => {
      params.delete('conversation')
      return params
    }, { replace: true })
  }, [conversationParam, setSearchParams])

  const conversationsQuery = useQuery<SupportConversationListResponse>({
    queryKey: ['support', 'user', 'conversations', base],
    queryFn: ({ signal }) => apiFetch<SupportConversationListResponse>(`${base}/conversations`, { signal }),
    meta: { suppressGlobalErrorToast: true }
  })

  const conversations = conversationsQuery.data?.conversations ?? []

  // Placed by `ListSection` below, exactly like every other account tab's CTA.
  // It used to sit ABOVE the list when hosted in the account scope, which was
  // the one tab putting its action somewhere different from its neighbours.
  const newMessageButton = (
    <Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setComposerOpen(true)}>
      New message
    </Button>
  )

  return (
    <Stack spacing={1.25}>
      {headingShownElsewhere ? null : (
        <PageSectionHeading
          level={standalone ? 'h3' : 'title-lg'}
          icon={<ForumRoundedIcon />}
          title="Messages"
          description="Your conversations with the PrintStream team: questions, feedback, and bug reports."
          count={conversations.length}
          actions={newMessageButton}
        />
      )}

      {(
        // The same section shape as the account's other tabs, loading included:
        // this used to print "Loading…" and then swap it for a list, which
        // moved the page under the reader.
        <ListSection
          isLoading={conversationsQuery.isPending}
          isEmpty={conversations.length === 0}
          emptyIcon={<ForumRoundedIcon />}
          emptyTitle="No conversations yet"
          emptyDescription="Anything you send with the Help and feedback button shows up here."
          actions={headingShownElsewhere ? newMessageButton : undefined}
        >
          <Stack spacing={1}>
            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                onOpen={() => setOpenConversationId(conversation.id)}
              />
            ))}
          </Stack>
        </ListSection>
      )}

      {composerOpen && <HelpFeedbackDialog showConversations={false} onClose={() => setComposerOpen(false)} />}
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
