import type { RequestAuditLogAnnotation } from './lib/audit-logs.js'
import type { RequestAuthContext } from './lib/auth-context.js'
import type { RequestWorkspaceSummary } from './lib/workspace-context.js'

declare global {
  namespace Express {
    interface Request {
      auth: RequestAuthContext
      auditLog?: RequestAuditLogAnnotation
      workspace: RequestWorkspaceSummary | null
    }
  }
}

export {}