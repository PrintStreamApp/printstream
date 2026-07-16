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

/** Hard cap on one support attachment upload. */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 150 * 1024 * 1024

/**
 * Cap on the combined size of one message's attachments.
 *
 * The per-file cap alone would let one message carry
 * `MAX_PER_MESSAGE * MAX_BYTES` (750 MB) of durable platform storage, so the
 * total is bounded separately and enforced at claim time — the only point where
 * the whole set is known.
 */
export const SUPPORT_ATTACHMENTS_MAX_TOTAL_BYTES = 300 * 1024 * 1024

/** Most attachments a single support message may carry. */
export const SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE = 5

/**
 * Per-request ceiling for one upload chunk, advertised by the begin response.
 *
 * Attachments are uploaded in chunks rather than as one request because the
 * cap above exceeds what a single request can carry end-to-end: the cloud
 * deployment sits behind a proxy that rejects bodies over 100 MB, and a
 * multi-minute single-shot upload has no way to resume after a dropped
 * connection. Keep this well under any proxy body limit.
 */
export const SUPPORT_ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024

/** Body of `POST .../attachments/uploads`, which opens an upload session. */
export const beginSupportAttachmentUploadRequestSchema = z.object({
  filename: z.string().trim().min(1, 'A filename is required.').max(200),
  contentType: z.string().trim().max(100).optional(),
  sizeBytes: z.number().int().min(1).max(SUPPORT_ATTACHMENT_MAX_BYTES)
})
export type BeginSupportAttachmentUploadRequest = z.infer<typeof beginSupportAttachmentUploadRequestSchema>

/** Response of `POST .../attachments/uploads`. `uploadedBytes` is the resume offset. */
export const beginSupportAttachmentUploadResponseSchema = z.object({
  uploadId: z.string(),
  chunkSizeBytes: z.number().int().positive(),
  uploadedBytes: z.number().int().nonnegative()
})
export type BeginSupportAttachmentUploadResponse = z.infer<typeof beginSupportAttachmentUploadResponseSchema>

/** Response of `POST .../attachments/uploads/:id/chunks`. */
export const supportAttachmentChunkResponseSchema = z.object({
  uploadedBytes: z.number().int().nonnegative(),
  complete: z.boolean()
})
export type SupportAttachmentChunkResponse = z.infer<typeof supportAttachmentChunkResponseSchema>

/**
 * Response of `GET .../attachments/uploads/:id` — the server's authoritative
 * received-byte count, which a client re-reads to resume after a failed chunk.
 */
export const supportAttachmentUploadStatusResponseSchema = z.object({
  uploadId: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  receivedBytes: z.number().int().nonnegative()
})
export type SupportAttachmentUploadStatusResponse = z.infer<typeof supportAttachmentUploadStatusResponseSchema>

/**
 * One file attached to a support message, as served back to clients (the
 * bytes are fetched separately from the attachment download endpoint).
 */
export const supportAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Safe to render inline as an `<img>`; anything else is download-only. */
  isImage: z.boolean()
})
export type SupportAttachment = z.infer<typeof supportAttachmentSchema>

/** Response of the raw-body attachment upload endpoints (`POST .../attachments`). */
export const supportAttachmentUploadResponseSchema = z.object({
  attachment: supportAttachmentSchema
})
export type SupportAttachmentUploadResponse = z.infer<typeof supportAttachmentUploadResponseSchema>

/** Ids of previously uploaded attachments a message send claims. */
export const supportAttachmentIdsSchema = z
  .array(z.string().min(1))
  .max(SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE, 'Too many attachments.')
  .optional()
  .default([])

export const createSupportConversationRequestSchema = z.object({
  kind: supportConversationKindSchema.exclude(['message']),
  message: z.string().trim().min(1, 'A message is required.').max(5_000),
  /** In-app path the user was on when they opened the dialog. */
  pageUrl: z.string().trim().max(500).optional(),
  attachmentIds: supportAttachmentIdsSchema
})
export type CreateSupportConversationRequest = z.infer<typeof createSupportConversationRequestSchema>

export const createSupportConversationResponseSchema = z.object({
  ok: z.literal(true),
  conversationId: z.string()
})
export type CreateSupportConversationResponse = z.infer<typeof createSupportConversationResponseSchema>
