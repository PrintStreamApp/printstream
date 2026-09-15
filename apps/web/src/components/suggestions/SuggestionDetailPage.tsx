/**
 * Suggestion discussion page: the full post with voting, its triage status
 * (a chip, or a live selector for platform admins), author/admin deletion,
 * and the threaded comment section.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { Button, Card, Divider, Stack, Typography } from '@mui/joy'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import {
  extractErrorMessage,
  type SuggestionDetailResponse,
  type SuggestionStatus,
  type SuggestionVoteValue
} from '@printstream/shared'
import { apiFetch, ApiError } from '../../lib/apiClient'
import { Markdown } from '../Markdown'
import { usePromptDialog } from '../PromptDialogProvider'
import { SuggestionComments } from './SuggestionComments'
import { SuggestionStatusChip } from './SuggestionStatusChip'
import { SuggestionStatusSelect } from './SuggestionStatusSelect'
import { VoteButtons } from './VoteButtons'
import { ListSkeleton } from '../ListSkeleton'

/** Keep not-found copy distinct from transport, entitlement, and server errors. */
function describeSuggestionLoadError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'This suggestion no longer exists.'
  }
  return extractErrorMessage(error)
}

export function SuggestionDetailPage({
  apiBase = '/api/plugins/suggestions',
  onBack
}: {
  apiBase?: string
  onBack: () => void
}) {
  const { suggestionId } = useParams<{ suggestionId: string }>()
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()

  const detailQuery = useQuery<SuggestionDetailResponse>({
    queryKey: ['suggestions', apiBase, 'detail', suggestionId],
    queryFn: ({ signal }) => apiFetch<SuggestionDetailResponse>(`${apiBase}/${suggestionId}`, { signal }),
    enabled: Boolean(suggestionId)
  })

  const voteMutation = useMutation({
    mutationFn: (value: SuggestionVoteValue) =>
      apiFetch(`${apiBase}/${suggestionId}/vote`, { method: 'PUT', body: { value } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['suggestions'] })
    }
  })

  const statusMutation = useMutation({
    mutationFn: (status: SuggestionStatus) =>
      apiFetch(`${apiBase}/${suggestionId}/status`, { method: 'PUT', body: { status } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['suggestions'] })
    }
  })

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`${apiBase}/${suggestionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['suggestions'] })
      onBack()
    }
  })

  const handleDelete = async () => {
    const confirmed = await confirm({
      title: 'Delete this suggestion?',
      description: 'The post, its votes, and its whole discussion are removed for everyone. This cannot be undone.',
      confirmLabel: 'Delete suggestion',
      color: 'danger'
    })
    if (confirmed) deleteMutation.mutate()
  }

  const data = detailQuery.data
  let detailError: string | null = null
  if (detailQuery.isError) {
    detailError = describeSuggestionLoadError(detailQuery.error)
  } else if (!data && !detailQuery.isPending) {
    detailError = 'This suggestion could not be loaded.'
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button variant="plain" color="neutral" size="sm" startDecorator={<ArrowBackRoundedIcon />} onClick={onBack}>
          All suggestions
        </Button>
      </Stack>

      {detailQuery.isPending ? (
        <ListSkeleton rows={2} />
      ) : detailError || !data ? (
        <Typography level="body-sm" color="danger">{detailError}</Typography>
      ) : (
        <>
          <Card variant="outlined" sx={{ flexDirection: 'row', alignItems: 'flex-start', gap: 1.5 }}>
            <VoteButtons
              score={data.suggestion.score}
              myVote={data.suggestion.myVote}
              disabled={voteMutation.isPending}
              onVote={(value) => voteMutation.mutate(value)}
            />
            <Stack spacing={0.75} sx={{ minWidth: 0, flex: 1 }}>
              <Stack direction="row" spacing={1} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Typography level="h3">{data.suggestion.title}</Typography>
                {data.suggestion.canSetStatus ? (
                  <SuggestionStatusSelect
                    status={data.suggestion.status}
                    disabled={statusMutation.isPending}
                    onChange={(status) => statusMutation.mutate(status)}
                  />
                ) : data.suggestion.status !== 'open' ? (
                  <SuggestionStatusChip status={data.suggestion.status} />
                ) : null}
              </Stack>
              {data.suggestion.body && <Markdown>{data.suggestion.body}</Markdown>}
              <Stack direction="row" spacing={1} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Typography level="body-xs" textColor="text.tertiary">
                  {data.suggestion.authorName} · {new Date(data.suggestion.createdAt).toLocaleDateString()}
                </Typography>
                {data.suggestion.canDelete && (
                  <Button
                    size="sm"
                    variant="plain"
                    color="danger"
                    startDecorator={<DeleteOutlineRoundedIcon />}
                    loading={deleteMutation.isPending}
                    onClick={() => { void handleDelete() }}
                    sx={{ ml: 'auto' }}
                  >
                    Delete
                  </Button>
                )}
              </Stack>
              {data.suggestion.operatorContext && (
                <OperatorContext context={data.suggestion.operatorContext} />
              )}
            </Stack>
          </Card>

          <Divider />

          <SuggestionComments apiBase={apiBase} suggestionId={data.suggestion.id} comments={data.comments} />
        </>
      )}
    </Stack>
  )
}

function OperatorContext({
  context
}: {
  context: NonNullable<SuggestionDetailResponse['suggestion']['operatorContext']>
}) {
  return (
    <Typography level="body-xs" textColor="text.tertiary">
      Customer {context.customerId} · Licence {context.licenseId} · Install {context.installationFingerprint}
    </Typography>
  )
}
