/**
 * Help & feedback contract for the core web dialog.
 *
 * On the hosted (cloud) deployment the dialog starts a two-way support
 * conversation (`POST /api/support/conversations`, mounted by the private
 * cloud module); replies land in the user's Account → Messages section.
 * Self-hosted installs cannot reach the platform, so the same dialog composes
 * an email to `SUPPORT_CONTACT_EMAIL` instead. The schema lives in the public
 * shared package because the core dialog builds the payload on both
 * deployments.
 */
import { z } from 'zod'

/** Where help/feedback lands when an install cannot message the platform. */
export const SUPPORT_CONTACT_EMAIL = 'contact@printstream.app'

/**
 * What a conversation is about. `feedback`/`bug`/`question` are user-initiated
 * from the help dialog; `message` is a platform-initiated conversation.
 */
export const supportConversationKindSchema = z.enum(['feedback', 'bug', 'question', 'message'])
export type SupportConversationKind = z.infer<typeof supportConversationKindSchema>

export const createSupportConversationRequestSchema = z.object({
  kind: supportConversationKindSchema.exclude(['message']),
  message: z.string().trim().min(1, 'A message is required.').max(5_000),
  /** In-app path the user was on when they opened the dialog. */
  pageUrl: z.string().trim().max(500).optional()
})
export type CreateSupportConversationRequest = z.infer<typeof createSupportConversationRequestSchema>

export const createSupportConversationResponseSchema = z.object({
  ok: z.literal(true),
  conversationId: z.string()
})
export type CreateSupportConversationResponse = z.infer<typeof createSupportConversationResponseSchema>
