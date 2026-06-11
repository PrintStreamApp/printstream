/**
 * Shared one-time email-code issuance helper used by both self-serve requests
 * and admin-triggered invites.
 */
import crypto from 'node:crypto'
import type { AuthUserInviteResult } from '@printstream/shared'
import { env } from '../../lib/env.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import type { EmailCodeDeliveryResult, EmailCodeDeliveryInput } from './email-code-delivery.js'

export type EmailCodeIssuerServices = {
  now(): Date
  createCode(): string
  deliverEmailCode(input: EmailCodeDeliveryInput): Promise<EmailCodeDeliveryResult>
}

const EMAIL_AUTH_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export async function issueEmailCodeForUser(input: {
  prisma: AnyPrismaClient
  userId: string
  email: string
  redirectTo?: string | null
  inviteUrl?: string | null
  demoMode: boolean
  timeZone?: string | null
  locale?: string | null
  services: EmailCodeIssuerServices
}): Promise<AuthUserInviteResult> {
  const now = input.services.now()
  const expiresAt = new Date(now.getTime() + env.AUTH_LOCAL_EMAIL_CODE_TTL_MINUTES * 60_000)
  const normalizedEmail = normalizeEmailAuthAddress(input.email)

  await input.prisma.authEmailCodeToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { consumedAt: { not: null } },
        { email: normalizedEmail }
      ]
    }
  })

  const code = input.services.createCode()
  const tokenHash = hashEmailAuthCode(code)
  const createdToken = await input.prisma.authEmailCodeToken.create({
    data: {
      userId: input.userId,
      email: normalizedEmail,
      tokenHash,
      redirectTo: input.redirectTo ?? null,
      expiresAt
    }
  })

  try {
    const delivery = await input.services.deliverEmailCode({
      email: input.email,
      code,
      expiresAt,
      demoMode: input.demoMode,
      inviteUrl: input.inviteUrl ?? null,
      timeZone: input.timeZone,
      locale: input.locale
    })

    return {
      delivered: true,
      expiresAt: expiresAt.toISOString(),
      previewCode: delivery.previewCode
    }
  } catch (error) {
    await input.prisma.authEmailCodeToken.delete({ where: { id: createdToken.id } }).catch(() => undefined)
    throw error
  }
}

export function hashEmailAuthCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeEmailAuthCode(code)).digest('hex')
}

export function normalizeEmailAuthCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function normalizeEmailAuthAddress(email: string): string {
  return email.trim().toLowerCase()
}

export function createEmailAuthCode(): string {
  const bytes = crypto.randomBytes(8)
  let compactCode = ''

  for (const byte of bytes) {
    compactCode += EMAIL_AUTH_CODE_ALPHABET[byte % EMAIL_AUTH_CODE_ALPHABET.length]
  }

  return `${compactCode.slice(0, 4)}-${compactCode.slice(4, 8)}`
}