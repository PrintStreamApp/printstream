import type { RequestAuditLogAnnotation } from './lib/audit-logs.js'
import type { RequestAuthContext } from './lib/auth-context.js'
import type { RequestTenantSummary } from './lib/tenant-context.js'

declare global {
  namespace Express {
    interface Request {
      auth: RequestAuthContext
      auditLog?: RequestAuditLogAnnotation
      tenant: RequestTenantSummary | null
    }
  }
}

export {}