/**
 * SMTP email transport plugin (built-in, self-hosted/OSS only).
 *
 * Lets a self-hosted operator point PrintStream at their own SMTP server so
 * email-backed features (currently the `notifications-email` channel) can deliver
 * without a cloud email provider. It owns only the server-wide SMTP config + the
 * transport registration; consumers send through the core email-transport
 * registry, never by importing this plugin.
 *
 * Routes (all gated by `settings.manage`, audited, secret never echoed):
 * - `GET /api/plugins/email-smtp` — current SMTP config (no password).
 * - `PUT /api/plugins/email-smtp/config` — set host/port/secure/username/from + password.
 * - `DELETE /api/plugins/email-smtp/config` — clear all SMTP settings.
 * - `POST /api/plugins/email-smtp/test` — send a test email to a given address.
 */
import { z } from 'zod'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { emailTransportRegistry, type RegisteredEmailTransport } from '../../lib/email-delivery.js'
import { badRequest } from '../../lib/http-error.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { encryptSecret } from '../../lib/secret-encryption.js'
import type { ApiPlugin } from '../../plugin/types.js'
import { createSmtpTransport, readSmtpConfig, type SmtpTransporterFactory } from './transport.js'

const smtpConfigSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional().default(false),
  username: z.string().trim().max(255).nullable().optional(),
  // Write-only: omit to keep the stored password, '' to clear it.
  password: z.string().max(1024).nullable().optional(),
  fromEmail: z.string().trim().email().max(320),
  fromName: z.string().trim().max(120).nullable().optional()
})

const smtpTestSchema = z.object({
  to: z.string().trim().email().max(320)
})

export function createEmailSmtpPlugin(deps: { createTransporter?: SmtpTransporterFactory } = {}): ApiPlugin {
  return {
    name: 'email-smtp',
    version: '0.1.0',
    description: 'Send email through your own SMTP server (self-hosted).',
    async register(context) {
      const transport: RegisteredEmailTransport = createSmtpTransport(context.settings, deps)
      context.onShutdown(emailTransportRegistry.register(transport))

      context.router.get('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (_request, response) => {
        const configured = (await readSmtpConfig(context.settings)) != null
        response.json({
          configured,
          host: (await context.settings.get('host')) || null,
          port: (await context.settings.get('port')) || null,
          secure: (await context.settings.get('secure')) === 'true',
          username: (await context.settings.get('username')) || null,
          fromEmail: (await context.settings.get('fromEmail')) || null,
          fromName: (await context.settings.get('fromName')) || null,
          hasPassword: Boolean(await context.settings.get('password'))
        })
      })

      context.router.put('/config', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
        const parsed = smtpConfigSchema.safeParse(request.body)
        if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid SMTP configuration.')
        const data = parsed.data

        await context.settings.set('host', data.host)
        await context.settings.set('port', data.port != null ? String(data.port) : '')
        await context.settings.set('secure', data.secure ? 'true' : 'false')
        await context.settings.set('username', data.username?.trim() || '')
        await context.settings.set('fromEmail', data.fromEmail)
        await context.settings.set('fromName', data.fromName?.trim() || '')
        if (data.password !== undefined && data.password !== null) {
          if (data.password) {
            await context.settings.set('password', encryptSecret(data.password))
          } else {
            await context.settings.delete('password')
          }
        }

        annotateRequestAuditLog(request, {
          action: 'update-smtp-config',
          resource: 'SMTP transport',
          summary: 'Updated the SMTP email configuration.',
          metadata: { configured: true, host: data.host }
        })

        response.json({ configured: (await readSmtpConfig(context.settings)) != null })
      })

      context.router.delete('/config', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
        for (const key of ['host', 'port', 'secure', 'username', 'password', 'fromEmail', 'fromName']) {
          await context.settings.delete(key)
        }
        annotateRequestAuditLog(request, {
          action: 'clear-smtp-config',
          resource: 'SMTP transport',
          summary: 'Cleared the SMTP email configuration.',
          metadata: { configured: false }
        })
        response.json({ configured: false })
      })

      context.router.post('/test', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
        const parsed = smtpTestSchema.safeParse(request.body)
        if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid test recipient.')
        if (!(await readSmtpConfig(context.settings))) {
          throw badRequest('Configure SMTP before sending a test email.')
        }
        try {
          await transport.send({
            to: parsed.data.to,
            subject: 'PrintStream SMTP test',
            text: 'This is a test email confirming your PrintStream SMTP configuration works.'
          })
          response.json({ ok: true })
        } catch (error) {
          // Surface the failure to the operator without leaking credentials.
          context.logger.warn('SMTP test email failed', error)
          response.json({ ok: false, error: error instanceof Error ? error.message : 'SMTP delivery failed.' })
        }
      })
    }
  }
}

export const emailSmtpPlugin = createEmailSmtpPlugin()
