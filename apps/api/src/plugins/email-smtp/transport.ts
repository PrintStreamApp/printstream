/**
 * SMTP email transport (OSS).
 *
 * Reads the operator's server-wide SMTP settings from the plugin setting store
 * and delivers via nodemailer. Registered into the core email-transport registry
 * by the plugin so `notifications-email` (and any future flow) can send mail in
 * self-hosted builds without a cloud email provider. The password is stored
 * encrypted at rest (`secret-encryption.ts`) and never returned to clients.
 */
import nodemailer from 'nodemailer'
import type { EmailInput, RegisteredEmailTransport } from '../../lib/email-delivery.js'
import { decryptSecret } from '../../lib/secret-encryption.js'
import type { PluginSettingStore } from '../../plugin/types.js'

export const SMTP_TRANSPORT_NAME = 'smtp'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  username: string | null
  password: string | null
  fromEmail: string
  fromName: string | null
}

/** Minimal transporter surface so tests can inject a fake (no real SMTP). */
export interface SmtpTransporter {
  sendMail(message: {
    from: string
    to: string
    subject: string
    text: string
    html?: string
  }): Promise<unknown>
}

export type SmtpTransporterFactory = (config: SmtpConfig) => SmtpTransporter

const defaultTransporterFactory: SmtpTransporterFactory = (config) =>
  nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined
  })

/** Reads + decrypts the stored SMTP config; null when host or from-address is missing. */
export async function readSmtpConfig(settings: PluginSettingStore): Promise<SmtpConfig | null> {
  const host = (await settings.get('host'))?.trim() || null
  const fromEmail = (await settings.get('fromEmail'))?.trim() || null
  if (!host || !fromEmail) return null

  const secure = (await settings.get('secure')) === 'true'
  const parsedPort = Number.parseInt((await settings.get('port')) ?? '', 10)
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : (secure ? 465 : 587)
  const storedPassword = await settings.get('password')

  return {
    host,
    port,
    secure,
    username: (await settings.get('username'))?.trim() || null,
    password: storedPassword ? decryptSecret(storedPassword) : null,
    fromEmail,
    fromName: (await settings.get('fromName'))?.trim() || null
  }
}

/** Builds the registry transport backed by the given setting store. */
export function createSmtpTransport(
  settings: PluginSettingStore,
  deps: { createTransporter?: SmtpTransporterFactory } = {}
): RegisteredEmailTransport {
  const createTransporter = deps.createTransporter ?? defaultTransporterFactory
  return {
    name: SMTP_TRANSPORT_NAME,
    isConfigured: async () => (await readSmtpConfig(settings)) != null,
    send: async (input: EmailInput) => {
      const config = await readSmtpConfig(settings)
      if (!config) throw new Error('SMTP is not configured.')
      const fromEmail = input.fromEmail?.trim() || config.fromEmail
      const fromName = input.fromName === undefined ? config.fromName : input.fromName?.trim() || null
      await createTransporter(config).sendMail({
        from: formatEmailAddress(fromEmail, fromName),
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {})
      })
    }
  }
}

function formatEmailAddress(email: string, name: string | null): string {
  if (!name) return email
  return `${name.replaceAll('"', '\\"')} <${email}>`
}
