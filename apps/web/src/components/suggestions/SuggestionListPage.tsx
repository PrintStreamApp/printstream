/**
 * Suggestion board list: posts sorted by score ("Top") or recency ("New"),
 * filterable by status, with inline voting, a comment count, and the
 * "New suggestion" composer.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Option, Select, Stack, ToggleButtonGroup, Typography } from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import ChatBubbleOutlineRoundedIcon from '@mui/icons-material/ChatBubbleOutlineRounded'
import EmojiObjectsOutlinedIcon from '@mui/icons-material/EmojiObjectsOutlined'
import EmojiObjectsRoundedIcon from '@mui/icons-material/EmojiObjectsRounded'
import {
  extractErrorMessage,
  suggestionStatusLabels,
  suggestionStatusSchema,
  type Suggestion,
  type SuggestionListResponse,
  type SuggestionSort,
  type SuggestionStatus,
  type SuggestionVoteValue
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { ListSection } from '../ListSection'
import { PaginationFooter } from '../PaginationFooter'
import { NewSuggestionDialog } from './NewSuggestionDialog'
import { SuggestionStatusChip } from './SuggestionStatusChip'
import { VoteButtons } from './VoteButtons'

const PAGE_SIZE = 25

export function SuggestionListPage({
  apiBase = '/api/plugins/suggestions',
  onOpenSuggestion
}: {
  apiBase?: string
  onOpenSuggestion: (id: string) => void
}) {
  const [sort, setSort] = useState<SuggestionSort>('top')
  const [status, setStatus] = useState<SuggestionStatus | null>(null)
  const [page, setPage] = useState(1)
  const [composerOpen, setComposerOpen] = useState(false)
  const queryClient = useQueryClient()

  const suggestionsQuery = useQuery<SuggestionListResponse>({
    queryKey: ['suggestions', apiBase, { sort, status, page }],
    queryFn: ({ signal }) => apiFetch<SuggestionListResponse>(
      `${apiBase}?sort=${sort}&page=${page}&pageSize=${PAGE_SIZE}${status ? `&status=${status}` : ''}`,
      { signal }
    )
  })

  const voteMutation = useMutation({
    mutationFn: ({ suggestionId, value }: { suggestionId: string; value: SuggestionVoteValue }) =>
      apiFetch(`${apiBase}/${suggestionId}/vote`, { method: 'PUT', body: { value } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['suggestions'] })
    }
  })

  const data = suggestionsQuery.data
  const suggestions = data?.suggestions ?? []
  const total = data?.total ?? 0
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const loadError = suggestionsQuery.isError
    ? extractErrorMessage(suggestionsQuery.error)
    : null

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          justifyContent="space-between"
          alignItems="center"
          sx={{ flexWrap: 'wrap' }}
        >
          <Typography level="h3" startDecorator={<EmojiObjectsOutlinedIcon />}>Suggestions</Typography>
          <Stack direction="row" spacing={1} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Select
              size="sm"
              placeholder="All statuses"
              value={status}
              // Size the listbox to its content instead of the trigger width
              // so no status label truncates.
              slotProps={{
                listbox: {
                  modifiers: [{ name: 'equalWidth', enabled: false }],
                  sx: { width: 'max-content' }
                }
              }}
              onChange={(_event, next) => {
                setStatus(next)
                setPage(1)
              }}
            >
              <Option value={null}>All statuses</Option>
              {suggestionStatusSchema.options.map((option) => (
                <Option key={option} value={option}>{suggestionStatusLabels[option]}</Option>
              ))}
            </Select>
            <ToggleButtonGroup
              size="sm"
              value={sort}
              onChange={(_event, next) => {
                if (!next) return
                setSort(next)
                setPage(1)
              }}
            >
              <Button value="top">Top</Button>
              <Button value="new">New</Button>
            </ToggleButtonGroup>
            <Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setComposerOpen(true)}>
              New suggestion
            </Button>
          </Stack>
        </Stack>
        <Typography level="body-sm" textColor="text.tertiary">
          Ideas for PrintStream from the whole community. Vote for the ones you want, or add your own.
        </Typography>
      </Stack>

      <ListSection
        isLoading={suggestionsQuery.isPending}
        isEmpty={!loadError && suggestions.length === 0}
        error={loadError}
        emptyIcon={<EmojiObjectsRoundedIcon />}
        emptyTitle={status
          ? `No ${suggestionStatusLabels[status].toLowerCase()} suggestions`
          : 'No suggestions yet'}
        emptyDescription={status
          ? 'Nothing has this status right now. Clear the filter to see the whole board.'
          : 'Be the first: post an idea and let others vote on it.'}
        // Only without a filter: inviting a first post while a filter is hiding
        // the board would be answering a question nobody asked.
        actions={status || loadError ? undefined : (
          <Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => setComposerOpen(true)}>
            New suggestion
          </Button>
        )}
      >
        <Stack spacing={1.5}>
          {suggestions.map((suggestion) => (
            <SuggestionListCard
              key={suggestion.id}
              suggestion={suggestion}
              voting={voteMutation.isPending && voteMutation.variables?.suggestionId === suggestion.id}
              onVote={(value) => voteMutation.mutate({ suggestionId: suggestion.id, value })}
              onOpen={() => onOpenSuggestion(suggestion.id)}
            />
          ))}
        </Stack>
      </ListSection>

      {total > PAGE_SIZE && (
        <PaginationFooter
          showingLabel={`Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`}
          previousDisabled={page <= 1}
          nextDisabled={page >= lastPage}
          onPrevious={() => setPage((current) => Math.max(1, current - 1))}
          onNext={() => setPage((current) => Math.min(lastPage, current + 1))}
        />
      )}

      {composerOpen && (
        <NewSuggestionDialog
          apiBase={apiBase}
          onClose={() => setComposerOpen(false)}
          onCreated={(suggestionId) => {
            setComposerOpen(false)
            void queryClient.invalidateQueries({ queryKey: ['suggestions'] })
            onOpenSuggestion(suggestionId)
          }}
        />
      )}
    </Stack>
  )
}

function SuggestionListCard({
  suggestion,
  voting,
  onVote,
  onOpen
}: {
  suggestion: Suggestion
  voting: boolean
  onVote: (value: SuggestionVoteValue) => void
  onOpen: () => void
}) {
  return (
    // The whole row opens the discussion (settings-overview-card pattern);
    // the vote control stops propagation so voting never navigates.
    <Card
      variant="outlined"
      onClick={onOpen}
      sx={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 1.5,
        cursor: 'pointer',
        transition: 'background-color 0.2s ease, border-color 0.2s ease',
        '&:hover': {
          backgroundColor: 'background.level1',
          borderColor: 'primary.softColor'
        },
        '&:has(:focus-visible)': {
          outline: '2px solid',
          outlineColor: 'focusVisible',
          outlineOffset: '2px'
        }
      }}
    >
      <VoteButtons score={suggestion.score} myVote={suggestion.myVote} disabled={voting} onVote={onVote} />
      <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
          {/* A real button so keyboard users can open the row with Enter. */}
          <Typography
            level="title-md"
            component="button"
            onClick={onOpen}
            sx={{
              textAlign: 'left',
              background: 'none',
              border: 'none',
              p: 0,
              cursor: 'pointer',
              color: 'inherit',
              '&:focus-visible': { outline: 'none' }
            }}
          >
            {suggestion.title}
          </Typography>
          {/* Untriaged posts stay chipless: "Open" on every card is noise. */}
          {suggestion.status !== 'open' && <SuggestionStatusChip status={suggestion.status} />}
        </Stack>
        {suggestion.body && (
          <Typography
            level="body-sm"
            textColor="text.tertiary"
            sx={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {suggestion.body}
          </Typography>
        )}
        <Stack direction="row" spacing={1.5} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
          <Typography level="body-xs" textColor="text.tertiary">
            {suggestion.authorName} · {new Date(suggestion.createdAt).toLocaleDateString()}
          </Typography>
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            startDecorator={<ChatBubbleOutlineRoundedIcon fontSize="inherit" />}
          >
            {suggestion.commentCount}
          </Typography>
        </Stack>
      </Stack>
    </Card>
  )
}
