/**
 * Suggestion-board contracts shared by hosted and connected self-hosted clients:
 * a platform-wide product-feedback board shared across all workspaces, where any
 * signed-in cloud user can post a suggestion, vote it up or down, and discuss
 * it in comment threads. Persistence and moderation remain cloud-only.
 */
import { z } from 'zod'

export const suggestionVoteValueSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)])
export type SuggestionVoteValue = z.infer<typeof suggestionVoteValueSchema>

/**
 * The platform team's triage state for a suggestion, set by platform admins:
 * `open` (untriaged, the default), `investigating` (being looked into),
 * `planned` (accepted, on the roadmap), `in-progress` (being built),
 * `completed` (shipped), `declined` (considered, won't be done), and
 * `not-possible` (can't be done, e.g. a platform or hardware limitation).
 */
export const suggestionStatusSchema = z.enum([
  'open',
  'investigating',
  'planned',
  'in-progress',
  'completed',
  'declined',
  'not-possible'
])
export type SuggestionStatus = z.infer<typeof suggestionStatusSchema>

/** Display labels for suggestion statuses (web chips + notification copy). */
export const suggestionStatusLabels: Record<SuggestionStatus, string> = {
  open: 'Open',
  investigating: 'Investigating',
  planned: 'Planned',
  'in-progress': 'In progress',
  completed: 'Completed',
  declined: 'Declined',
  'not-possible': 'Not possible'
}

/** Private origin details returned only to platform operators. */
export const suggestionOperatorContextSchema = z.object({
  customerId: z.string(),
  licenseId: z.string(),
  installationFingerprint: z.string()
})
export type SuggestionOperatorContext = z.infer<typeof suggestionOperatorContextSchema>

/** One suggestion post with its vote tallies as seen by the requesting user. */
export const suggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: suggestionStatusSchema,
  /** Display name snapshot; survives account deletion. */
  authorName: z.string(),
  createdAt: z.string().datetime(),
  score: z.number().int(),
  upvotes: z.number().int().nonnegative(),
  downvotes: z.number().int().nonnegative(),
  /** The requesting user's current vote. */
  myVote: suggestionVoteValueSchema,
  commentCount: z.number().int().nonnegative(),
  /** Whether the requesting user may delete this post (author or platform admin). */
  canDelete: z.boolean(),
  /** Whether the requesting user may change the status (platform admin). */
  canSetStatus: z.boolean(),
  /** Present only for operators viewing a self-hosted Customer action. */
  operatorContext: suggestionOperatorContextSchema.optional()
})
export type Suggestion = z.infer<typeof suggestionSchema>

export const suggestionSortSchema = z.enum(['top', 'new'])
export type SuggestionSort = z.infer<typeof suggestionSortSchema>

export const suggestionListQuerySchema = z.object({
  sort: suggestionSortSchema.default('top'),
  /** When present, only suggestions in this status are returned. */
  status: suggestionStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
})
export type SuggestionListQuery = z.infer<typeof suggestionListQuerySchema>

export const suggestionListResponseSchema = z.object({
  suggestions: z.array(suggestionSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive()
})
export type SuggestionListResponse = z.infer<typeof suggestionListResponseSchema>

export const createSuggestionRequestSchema = z.object({
  title: z.string().trim().min(1, 'A title is required.').max(120),
  body: z.string().trim().max(5_000).optional().default('')
})
export type CreateSuggestionRequest = z.infer<typeof createSuggestionRequestSchema>

export const suggestionResponseSchema = z.object({
  suggestion: suggestionSchema
})
export type SuggestionResponse = z.infer<typeof suggestionResponseSchema>

/** One comment. Replies reference their top-level parent via `parentId` (one nesting level). */
export const suggestionCommentSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
  canDelete: z.boolean(),
  /** Present only for operators viewing a self-hosted Customer action. */
  operatorContext: suggestionOperatorContextSchema.optional()
})
export type SuggestionComment = z.infer<typeof suggestionCommentSchema>

export const suggestionDetailResponseSchema = z.object({
  suggestion: suggestionSchema,
  /** All comments for the post, oldest first; the client groups replies under parents. */
  comments: z.array(suggestionCommentSchema)
})
export type SuggestionDetailResponse = z.infer<typeof suggestionDetailResponseSchema>

export const setSuggestionStatusRequestSchema = z.object({
  status: suggestionStatusSchema
})
export type SetSuggestionStatusRequest = z.infer<typeof setSuggestionStatusRequestSchema>

export const suggestionVoteRequestSchema = z.object({
  /** The user's new vote; `0` clears an existing vote. */
  value: suggestionVoteValueSchema
})
export type SuggestionVoteRequest = z.infer<typeof suggestionVoteRequestSchema>

export const suggestionVoteResponseSchema = z.object({
  score: z.number().int(),
  upvotes: z.number().int().nonnegative(),
  downvotes: z.number().int().nonnegative(),
  myVote: suggestionVoteValueSchema
})
export type SuggestionVoteResponse = z.infer<typeof suggestionVoteResponseSchema>

export const createSuggestionCommentRequestSchema = z.object({
  body: z.string().trim().min(1, 'A comment is required.').max(2_000),
  /** Reply target: a top-level comment id on the same suggestion. */
  parentId: z.string().optional()
})
export type CreateSuggestionCommentRequest = z.infer<typeof createSuggestionCommentRequestSchema>

export const suggestionCommentResponseSchema = z.object({
  comment: suggestionCommentSchema
})
export type SuggestionCommentResponse = z.infer<typeof suggestionCommentResponseSchema>
