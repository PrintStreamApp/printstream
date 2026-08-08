/**
 * A section holding a list that may be empty, with the actions that add to it.
 *
 * The account tabs each used to assemble this themselves and drifted:
 * workspaces and licences rendered a list or an `EmptyState` straight into the
 * section, while payment and invoices wrapped theirs in an outlined `Card` and
 * wrote "nothing yet" as a line of grey text, and messages wrote its own third
 * variation. Same page, three appearances.
 *
 * This is the workspaces/licences version, made reusable. Content, empty state
 * or loading skeleton, one error slot above, and actions below the content and
 * left-aligned.
 *
 * It owns LOADING too, not just empty-vs-content. Left to callers that state
 * became the word "Loading…" in nineteen files — which says only that
 * something is happening, where a skeleton says what is coming and stops the
 * page jumping when it lands.
 *
 * Core rather than `private/cloud`, and named for what it does rather than
 * where it started: the messages section renders outside the billing scope
 * too, so a "BillingScopeSection" would have been describing its first caller
 * instead of its job.
 *
 * Note it does NOT wrap anything in a Card: `EmptyState` is already a surface,
 * and the lists are already made of cards, so an outer one put a card inside a
 * card. That was the tell that a convention was being invented rather than
 * followed.
 *
 * The placeholder itself is the app-wide `EmptyState` — this only decides where
 * it sits and what surrounds it.
 */
import { Alert, Box, Stack } from '@mui/joy'
import type { ReactNode } from 'react'
import { EmptyState } from './EmptyState'
import { ListSkeleton } from './ListSkeleton'

export function ListSection({
  isLoading = false,
  skeletonRows,
  isEmpty,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  /** Offered in the empty state AND under the content, so it is reachable either way. */
  actions,
  error,
  children
}: {
  /** Shows placeholder rows instead of the empty state, which would be a lie. */
  isLoading?: boolean
  skeletonRows?: number
  isEmpty: boolean
  emptyIcon: ReactNode
  emptyTitle: string
  emptyDescription: string
  actions?: ReactNode
  error?: ReactNode
  children?: ReactNode
}) {
  return (
    <Stack spacing={1.5}>
      {error ? <Alert color="danger" variant="soft">{error}</Alert> : null}

      {isLoading ? (
        // Before the empty check, deliberately: an empty list and a list that
        // has not arrived look identical in the data and are opposite things to
        // a reader. Saying "nothing yet" while it loads is the worse mistake.
        <ListSkeleton rows={skeletonRows} />
      ) : isEmpty ? (
        <EmptyState
          icon={emptyIcon}
          title={emptyTitle}
          description={emptyDescription}
          action={actions}
        />
      ) : (
        <>
          {children}
          {/* Under the list, left-aligned. Inside the empty state the same
              actions are centred by the card — the two placements are the
              convention, not an accident of where each tab put its button. */}
          {actions ? <Box sx={{ alignSelf: 'flex-start' }}>{actions}</Box> : null}
        </>
      )}
    </Stack>
  )
}
