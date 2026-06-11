import { z } from 'zod'

export const auditActorTypeSchema = z.enum(['anonymous', 'user', 'service-account'])
export type AuditActorType = z.infer<typeof auditActorTypeSchema>

export const logLevelSchema = z.enum(['info', 'warn', 'error', 'debug'])
export type LogLevel = z.infer<typeof logLevelSchema>

export const systemLogEntrySchema = z.object({
  kind: z.literal('system'),
  timestamp: z.string().datetime(),
  level: logLevelSchema,
  message: z.string(),
  tenantId: z.string().nullable()
})

export type SystemLogEntry = z.infer<typeof systemLogEntrySchema>

export const auditLogEntrySchema = z.object({
  kind: z.literal('audit'),
  id: z.string(),
  timestamp: z.string().datetime(),
  tenantId: z.string().nullable(),
  actorType: auditActorTypeSchema,
  actorUserId: z.string().nullable(),
  actorServiceAccountId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  level: logLevelSchema,
  action: z.string().min(1),
  resource: z.string().min(1),
  summary: z.string().min(1),
  statusCode: z.number().int(),
  metadataJson: z.string().nullable().optional()
})

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>

export const logEntrySchema = z.discriminatedUnion('kind', [
  systemLogEntrySchema,
  auditLogEntrySchema
])

export type LogEntry = z.infer<typeof logEntrySchema>

export const logsResponseSchema = z.object({
  entries: z.array(logEntrySchema)
})

export type LogsResponse = z.infer<typeof logsResponseSchema>