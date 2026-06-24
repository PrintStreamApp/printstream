/**
 * Cloudflare Email Sending transport shared by beta signup and auth emails.
 */
import { env } from './env.js'
import { HttpError } from './http-error.js'

interface CloudflareEmailInput {
  to: string
  subject: string
  text: string
  html?: string
  fromEmail?: string
  fromName?: string | null
}

interface CloudflareEmailConfig {
  accountId: string
  apiToken: string
  fromEmail: string
  fromName: string | null
}

type EmailFetch = typeof fetch

export async function sendCloudflareEmail(input: CloudflareEmailInput): Promise<void> {
  const config = readCloudflareEmailConfig()
  if (!config) {
    throw new HttpError(503, 'Email delivery is not configured.')
  }

  await createCloudflareEmailSender(config)(input)
}

/**
 * Non-throwing capability check: whether Cloudflare Email Sending is fully
 * configured. Used by the email-transport registry to decide if this transport
 * can deliver, without the 503 that `sendCloudflareEmail` raises on a missing or
 * partial config.
 */
export function isCloudflareEmailConfigured(): boolean {
  try {
    return readCloudflareEmailConfig() != null
  } catch {
    // Partial config (some vars set, others missing) — treat as not configured.
    return false
  }
}

export function createCloudflareEmailSender(config: CloudflareEmailConfig, fetchEmail: EmailFetch = fetch) {
  return async function sendEmail(input: CloudflareEmailInput): Promise<void> {
    const fromEmail = input.fromEmail?.trim() || config.fromEmail
    const fromName = input.fromName === undefined ? config.fromName : input.fromName?.trim() || null
    const response = await fetchEmail(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        to: input.to,
        from: formatEmailAddress(fromEmail, fromName),
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {})
      })
    })

    const result = await readCloudflareResponse(response)
    if (!response.ok || isCloudflareFailure(result)) {
      throw new HttpError(502, 'Email delivery failed.')
    }
  }
}

async function readCloudflareResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function isCloudflareFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return 'success' in value && value.success === false
}

function readCloudflareEmailConfig(): CloudflareEmailConfig | null {
  const accountId = env.CLOUDFLARE_EMAIL_ACCOUNT_ID?.trim()
  const apiToken = env.CLOUDFLARE_EMAIL_API_TOKEN?.trim()
  const fromEmail = env.CLOUDFLARE_EMAIL_FROM_EMAIL?.trim()
  if (!accountId && !apiToken && !fromEmail) return null
  if (!accountId || !apiToken || !fromEmail) {
    throw new HttpError(503, 'Email delivery is misconfigured.')
  }

  return {
    accountId,
    apiToken,
    fromEmail,
    fromName: env.CLOUDFLARE_EMAIL_FROM_NAME?.trim() || null
  }
}

function formatEmailAddress(email: string, name: string | null): string {
  if (!name) return email
  return `${name.replaceAll('"', '\\"')} <${email}>`
}