/**
 * Comment section for a suggestion: a top-level composer plus one-level
 * threads (top-level comments with their replies indented beneath them).
 * Mutations invalidate the detail query; the server keeps reply nesting to a
 * single level regardless of which comment a reply targets.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Box, Button, Stack, Textarea, Typography } from '@mui/joy'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import ReplyRoundedIcon from '@mui/icons-material/ReplyRounded'
import type { SuggestionComment } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { Markdown } from '../Markdown'
import { usePromptDialog } from '../PromptDialogProvider'

export function SuggestionComments({
  apiBase = '/api/plugins/suggestions',
  suggestionId,
  comments
}: {
  apiBase?: string
  suggestionId: string
  comments: ReadonlyArray<SuggestionComment>
}) {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const [replyTarget, setReplyTarget] = useState<string | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['suggestions'] })
  }

  const addCommentMutation = useMutation({
    mutationFn: ({ body, parentId }: { body: string; parentId?: string }) =>
      apiFetch(`${apiBase}/${suggestionId}/comments`, {
        method: 'POST',
        body: { body, ...(parentId ? { parentId } : {}) }
      }),
    onSuccess: () => {
      setReplyTarget(null)
      invalidate()
    }
  })

  const deleteCommentMutation = useMutation({
    mutationFn: (commentId: string) =>
      apiFetch(`${apiBase}/${suggestionId}/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: invalidate
  })

  const handleDelete = async (comment: SuggestionComment, replyCount: number) => {
    const confirmed = await confirm({
      title: 'Delete this comment?',
      description: replyCount > 0
        ? `The comment and its ${replyCount === 1 ? 'reply' : `${replyCount} replies`} are removed for everyone.`
        : 'The comment is removed for everyone.',
      confirmLabel: 'Delete comment',
      color: 'danger'
    })
    if (confirmed) deleteCommentMutation.mutate(comment.id)
  }

  const topLevel = comments.filter((comment) => comment.parentId === null)
  const repliesByParent = new Map<string, SuggestionComment[]>()
  for (const comment of comments) {
    if (!comment.parentId) continue
    const list = repliesByParent.get(comment.parentId) ?? []
    list.push(comment)
    repliesByParent.set(comment.parentId, list)
  }

  return (
    <Stack spacing={2}>
      <Typography level="title-md">
        {comments.length === 0 ? 'Discussion' : `Discussion (${comments.length})`}
      </Typography>

      <CommentComposer
        placeholder="Add to the discussion…"
        submitting={addCommentMutation.isPending && replyTarget === null}
        onSubmit={(body) => addCommentMutation.mutate({ body })}
      />

      {topLevel.length === 0 ? (
        <Typography level="body-sm" textColor="text.tertiary">
          No comments yet. Start the discussion.
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {topLevel.map((comment) => {
            const replies = repliesByParent.get(comment.id) ?? []
            return (
              <Stack key={comment.id} spacing={1}>
                <CommentBlock
                  comment={comment}
                  onReply={() => setReplyTarget((current) => current === comment.id ? null : comment.id)}
                  onDelete={() => { void handleDelete(comment, replies.length) }}
                />
                {(replies.length > 0 || replyTarget === comment.id) && (
                  <Stack spacing={1} sx={{ pl: { xs: 2.5, sm: 4 }, borderLeft: '2px solid', borderColor: 'divider' }}>
                    {replies.map((reply) => (
                      <CommentBlock
                        key={reply.id}
                        comment={reply}
                        onReply={() => setReplyTarget((current) => current === comment.id ? null : comment.id)}
                        onDelete={() => { void handleDelete(reply, 0) }}
                      />
                    ))}
                    {replyTarget === comment.id && (
                      <CommentComposer
                        placeholder={`Reply to ${comment.authorName}…`}
                        autoFocus
                        submitting={addCommentMutation.isPending}
                        onSubmit={(body) => addCommentMutation.mutate({ body, parentId: comment.id })}
                        onCancel={() => setReplyTarget(null)}
                      />
                    )}
                  </Stack>
                )}
              </Stack>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}

function CommentBlock({
  comment,
  onReply,
  onDelete
}: {
  comment: SuggestionComment
  onReply: () => void
  onDelete: () => void
}) {
  return (
    <Stack spacing={0.25}>
      <Stack direction="row" spacing={1} useFlexGap alignItems="baseline" sx={{ flexWrap: 'wrap' }}>
        <Typography level="title-sm">{comment.authorName}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {new Date(comment.createdAt).toLocaleString()}
        </Typography>
      </Stack>
      {comment.operatorContext && (
        <Typography level="body-xs" textColor="text.tertiary">
          Customer {comment.operatorContext.customerId} · Licence {comment.operatorContext.licenseId} · Install{' '}
          {comment.operatorContext.installationFingerprint}
        </Typography>
      )}
      <Markdown>{comment.body}</Markdown>
      <Stack direction="row" spacing={0.5}>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          startDecorator={<ReplyRoundedIcon fontSize="small" />}
          onClick={onReply}
          sx={{ minHeight: 0, py: 0.25, color: 'neutral.500' }}
        >
          Reply
        </Button>
        {comment.canDelete && (
          <Button
            size="sm"
            variant="plain"
            color="danger"
            startDecorator={<DeleteOutlineRoundedIcon fontSize="small" />}
            onClick={onDelete}
            sx={{ minHeight: 0, py: 0.25 }}
          >
            Delete
          </Button>
        )}
      </Stack>
    </Stack>
  )
}

function CommentComposer({
  placeholder,
  submitting,
  autoFocus = false,
  onSubmit,
  onCancel
}: {
  placeholder: string
  submitting: boolean
  autoFocus?: boolean
  onSubmit: (body: string) => void
  onCancel?: () => void
}) {
  const [body, setBody] = useState('')
  const canSubmit = body.trim().length > 0

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || submitting) return
    onSubmit(body.trim())
    setBody('')
  }

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Textarea
        value={body}
        minRows={2}
        maxRows={8}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(event) => setBody(event.target.value)}
      />
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        {onCancel && (
          <Button type="button" variant="plain" color="neutral" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" loading={submitting} disabled={!canSubmit}>
          Comment
        </Button>
      </Stack>
    </Box>
  )
}
