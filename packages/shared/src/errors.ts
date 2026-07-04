/**
 * Small helpers for extracting human-readable messages from API error
 * responses. Both the API and the web app should rely on these instead
 * of repeating ad-hoc shape checks.
 */
export interface ApiErrorBody {
  error?: unknown
  message?: unknown
}

/**
 * Only this much of an HTML error body is scanned. A human-facing message never
 * needs more, and the cap keeps a huge (or adversarial) response body from
 * stalling the regexes below.
 */
const HTML_MESSAGE_SCAN_LIMIT = 8 * 1024

function extractHtmlErrorMessage(value: string): string | null {
  if (!/<[a-z][\s\S]*>/i.test(value)) return null

  const scan = value.slice(0, HTML_MESSAGE_SCAN_LIMIT)

  const title = scan.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()
  if (title) return title

  const heading = scan.match(/<h1[^>]*>([^<]*)<\/h1>/i)?.[1]?.trim()
  if (heading) return heading

  const text = scan
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return text || null
}

export function extractErrorMessage(value: unknown, fallback = 'Something went wrong'): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return fallback
    return extractHtmlErrorMessage(trimmed) ?? trimmed
  }
  if (value instanceof Error) {
    return extractErrorMessage(value.message, fallback)
  }
  if (value && typeof value === 'object') {
    const body = value as ApiErrorBody
    if (typeof body.error === 'string') {
      const message = extractErrorMessage(body.error, '')
      if (message) return message
    }
    if (typeof body.message === 'string') {
      const message = extractErrorMessage(body.message, '')
      if (message) return message
    }
  }
  return fallback
}
