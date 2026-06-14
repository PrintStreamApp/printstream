/**
 * Email delivery for local-auth one-time email codes.
 *
 * In demo mode we intentionally avoid side effects and return the generated
 * code instead so the auth flow stays testable without mail infra.
 */
import { sendCloudflareEmail } from '../../lib/cloudflare-email.js'
import type { PluginLogger } from '../../plugin/types.js'

export type EmailCodeDeliveryResult = {
  previewCode: string | null
}

export type EmailCodeDeliveryInput = {
  email: string
  code: string
  expiresAt: Date
  demoMode: boolean
  inviteUrl?: string | null
  timeZone?: string | null
  locale?: string | null
}

export function createEmailCodeDelivery(logger: PluginLogger) {
  return async function deliverEmailCode(input: EmailCodeDeliveryInput): Promise<EmailCodeDeliveryResult> {
    if (input.demoMode) {
      logger.info('Issued demo-mode sign-in code preview.', {
        email: input.email,
        code: input.code,
        expiresAt: input.expiresAt.toISOString()
      })
      return { previewCode: input.code }
    }

    await sendCloudflareEmail({
      to: input.email,
      subject: input.inviteUrl ? 'Your PrintStream invitation' : 'Your PrintStream sign-in code',
      text: buildEmailCodeTextBody(input.code, input.expiresAt, input),
      html: buildEmailCodeHtmlBody(input.code, input.expiresAt, input)
    })

    logger.info(input.inviteUrl ? 'Sent invitation email.' : 'Sent sign-in code email.', {
      email: input.email,
      expiresAt: input.expiresAt.toISOString()
    })
    return { previewCode: null }
  }
}

function buildEmailCodeTextBody(
  code: string,
  expiresAt: Date,
  options: Pick<EmailCodeDeliveryInput, 'inviteUrl' | 'timeZone' | 'locale'>
): string {
  if (options.inviteUrl) {
    return [
      'You have been invited to sign in to PrintStream.',
      '',
      'Open this link to continue:',
      options.inviteUrl,
      '',
      'Then enter this one-time code:',
      '',
      code,
      '',
      `This code expires at ${formatExpiryDate(expiresAt, options)}.`,
      'If you were not expecting this invitation, you can ignore this email.'
    ].join('\n')
  }

  return [
    'Use this one-time code to sign in to PrintStream:',
    '',
    code,
    '',
    'Enter the code on the PrintStream sign-in screen.',
    `This code expires at ${formatExpiryDate(expiresAt, options)}.`,
    'If you did not request this code, you can ignore this email.'
  ].join('\n')
}

function buildEmailCodeHtmlBody(
  code: string,
  expiresAt: Date,
  options: Pick<EmailCodeDeliveryInput, 'inviteUrl' | 'timeZone' | 'locale'>
): string {
  if (options.inviteUrl) {
    return [
      '<p>You have been invited to sign in to PrintStream.</p>',
      `<p><a href="${escapeHtml(options.inviteUrl)}">Open your invitation</a></p>`,
      '<p>Then enter this one-time code:</p>',
      `<p><strong style="font-size: 1.5rem; letter-spacing: 0.12em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${escapeHtml(code)}</strong></p>`,
      `<p>This code expires at ${escapeHtml(formatExpiryDate(expiresAt, options))}.</p>`,
      '<p>If you were not expecting this invitation, you can ignore this email.</p>'
    ].join('')
  }

  return [
    '<p>Use this one-time code to sign in to PrintStream:</p>',
    `<p><strong style="font-size: 1.5rem; letter-spacing: 0.12em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">${escapeHtml(code)}</strong></p>`,
    '<p>Enter the code on the PrintStream sign-in screen.</p>',
    `<p>This code expires at ${escapeHtml(formatExpiryDate(expiresAt, options))}.</p>`,
    '<p>If you did not request this code, you can ignore this email.</p>'
  ].join('')
}

function formatExpiryDate(
  expiresAt: Date,
  options: Pick<EmailCodeDeliveryInput, 'timeZone' | 'locale'>
): string {
  const formatterOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }

  return new Intl.DateTimeFormat(options.locale ?? 'en-US', {
    ...formatterOptions,
    timeZone: normalizeTimeZone(options.timeZone) ?? 'UTC'
  }).format(expiresAt)
}

function normalizeTimeZone(value?: string | null): string | null {
  const timeZone = value?.trim()
  if (!timeZone) return null

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
    return timeZone
  } catch {
    return null
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}