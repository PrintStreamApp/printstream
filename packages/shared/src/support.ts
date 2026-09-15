/**
 * Help & feedback contract for the core web dialog.
 *
 * On the hosted (cloud) deployment the dialog starts a two-way support
 * conversation (`POST /api/support/conversations`, mounted by the private
 * cloud module); replies land in the user's Account → Messages section.
 * A connected self-hosted install may relay the same conversation through its
 * cloud-connection plugin while commercial support is current. Disabled or
 * ineligible installs compose an email to `SUPPORT_CONTACT_EMAIL` instead. The
 * schema lives in the public shared package because both deployments and the
 * relay share the wire contract.
 */
import { z } from 'zod'

/** Where help/feedback lands when an install cannot message the platform. */
export const SUPPORT_CONTACT_EMAIL = 'contact@printstream.app'

/** Headers used only between a self-hosted relay and the vendor cloud. */
export const SELF_HOSTED_SUPPORT_LICENSE_HEADER = 'X-PrintStream-License-Key'
export const SELF_HOSTED_SUPPORT_INSTALLATION_HEADER = 'X-PrintStream-Installation-Id'
export const SELF_HOSTED_SUPPORT_CONTEXT_HEADER = 'X-PrintStream-Support-Context'

/** Non-identity diagnostics forwarded by the trusted self-hosted relay. */
export const selfHostedSupportContextSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200).nullable(),
  workspaceName: z.string().trim().min(1).max(200).nullable(),
  appVersion: z.string().trim().min(1).max(200).nullable(),
  userAgent: z.string().trim().min(1).max(500).nullable()
})
export type SelfHostedSupportContext = z.infer<typeof selfHostedSupportContextSchema>

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
 * total is bounded separately and enforced at claim time: the only point where
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
 * Response of `GET .../attachments/uploads/:id`: the server's authoritative
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

export const supportMessageSideSchema = z.enum(['user', 'platform'])
export type SupportMessageSide = z.infer<typeof supportMessageSideSchema>

export const supportMessageSchema = z.object({
  id: z.string(),
  side: supportMessageSideSchema,
  senderName: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
  attachments: z.array(supportAttachmentSchema),
  pageUrl: z.string().nullable(),
  appVersion: z.string().nullable(),
  userAgent: z.string().nullable()
})
export type SupportMessage = z.infer<typeof supportMessageSchema>

export const supportConversationStatusSchema = z.enum(['open', 'resolved'])
export type SupportConversationStatus = z.infer<typeof supportConversationStatusSchema>

/** One conversation as seen by the requesting side; `unreadCount` is viewer-relative. */
export const supportConversationSchema = z.object({
  id: z.string(),
  kind: supportConversationKindSchema,
  subject: z.string(),
  status: supportConversationStatusSchema,
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  /** Self-hosted origin snapshots; null for hosted-workspace conversations. */
  customerId: z.string().nullable().optional(),
  customerName: z.string().nullable().optional(),
  licenseId: z.string().nullable().optional(),
  licenseName: z.string().nullable().optional(),
  installationFingerprint: z.string().nullable().optional(),
  userRoles: z.array(z.string()),
  assignedToUserId: z.string().nullable(),
  assignedToName: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastMessageAt: z.string().datetime(),
  lastMessagePreview: z.string(),
  messageCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative()
})
export type SupportConversation = z.infer<typeof supportConversationSchema>

export const supportConversationListResponseSchema = z.object({ conversations: z.array(supportConversationSchema) })
export type SupportConversationListResponse = z.infer<typeof supportConversationListResponseSchema>

export const supportConversationDetailResponseSchema = z.object({
  conversation: supportConversationSchema,
  messages: z.array(supportMessageSchema)
})
export type SupportConversationDetailResponse = z.infer<typeof supportConversationDetailResponseSchema>

export const supportReplyRequestSchema = z.object({
  message: z.string().trim().min(1, 'A message is required.').max(5_000),
  attachmentIds: supportAttachmentIdsSchema
})
export type SupportReplyRequest = z.infer<typeof supportReplyRequestSchema>

export const supportMessageResponseSchema = z.object({ message: supportMessageSchema })
export type SupportMessageResponse = z.infer<typeof supportMessageResponseSchema>

export const supportUnreadResponseSchema = z.object({ count: z.number().int().nonnegative() })
export type SupportUnreadResponse = z.infer<typeof supportUnreadResponseSchema>

export const supportStatusFilterSchema = z.enum(['open', 'resolved', 'all'])
export type SupportStatusFilter = z.infer<typeof supportStatusFilterSchema>

export const platformSupportListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: supportStatusFilterSchema.default('open')
})
export type PlatformSupportListQuery = z.infer<typeof platformSupportListQuerySchema>

export const platformSupportListResponseSchema = z.object({
  conversations: z.array(supportConversationSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  openCount: z.number().int().nonnegative()
})
export type PlatformSupportListResponse = z.infer<typeof platformSupportListResponseSchema>

export const platformCreateConversationRequestSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  subject: z.string().trim().max(120).optional(),
  message: z.string().trim().min(1, 'A message is required.').max(5_000),
  attachmentIds: supportAttachmentIdsSchema
})
export type PlatformCreateConversationRequest = z.infer<typeof platformCreateConversationRequestSchema>

export const supportConversationResponseSchema = z.object({ conversation: supportConversationSchema })
export type SupportConversationResponse = z.infer<typeof supportConversationResponseSchema>

export const supportResolveRequestSchema = z.object({ resolved: z.boolean() })
export type SupportResolveRequest = z.infer<typeof supportResolveRequestSchema>

export const supportRecipientSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  roles: z.array(z.string())
})
export type SupportRecipient = z.infer<typeof supportRecipientSchema>

export const supportRecipientsResponseSchema = z.object({ recipients: z.array(supportRecipientSchema) })
export type SupportRecipientsResponse = z.infer<typeof supportRecipientsResponseSchema>
