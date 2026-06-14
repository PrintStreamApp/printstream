export interface ErrorToastMeta {
  suppressGlobalErrorToast?: boolean
}

const PASSIVE_AUTH_QUERY_MESSAGES = new Set([
  'Authentication required.',
  'You do not have permission to perform this action.'
])

export function shouldSuppressGlobalErrorToast(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') {
    return false
  }

  return (meta as ErrorToastMeta).suppressGlobalErrorToast === true
}

export function shouldSuppressPassiveAuthQueryError(error: unknown): boolean {
  return error instanceof Error && PASSIVE_AUTH_QUERY_MESSAGES.has(error.message)
}