/**
 * Core email-transport registry.
 *
 * Decouples *what* sends email (Cloudflare in cloud, SMTP in OSS) from *who*
 * wants to send it (the `notifications-email` plugin, future flows). Transports
 * register a backend here; consumers call `sendEmail()` / `isEmailDeliveryConfigured()`
 * without importing any transport plugin (the no-cross-plugin-import rule).
 *
 * The Cloudflare transport is registered at module load and is "configured" only
 * when its env is present (inert in OSS, active in cloud). The OSS `email-smtp`
 * plugin registers an SMTP backend when present.
 */
import { HttpError } from './http-error.js'
import { isCloudflareEmailConfigured, sendCloudflareEmail } from './cloudflare-email.js'
import { isSelfHostedDeployment } from './deployment-mode.js'

export interface EmailInput {
  to: string
  subject: string
  text: string
  html?: string
  fromEmail?: string
  fromName?: string | null
}

export interface RegisteredEmailTransport {
  /** Stable identifier, e.g. 'cloudflare' or 'smtp'. */
  name: string
  /** Whether this transport currently has enough configuration to deliver. */
  isConfigured(): boolean | Promise<boolean>
  send(input: EmailInput): Promise<void>
}

class EmailTransportRegistry {
  private readonly transports = new Map<string, RegisteredEmailTransport>()

  register(transport: RegisteredEmailTransport): () => void {
    this.transports.set(transport.name, transport)
    return () => {
      // Only remove if it is still the same instance (a re-register replaced it).
      if (this.transports.get(transport.name) === transport) {
        this.transports.delete(transport.name)
      }
    }
  }

  clear(): void {
    this.transports.clear()
  }

  /** First configured transport in registration order, or null. */
  async resolve(): Promise<RegisteredEmailTransport | null> {
    for (const transport of this.transports.values()) {
      if (await transport.isConfigured()) return transport
    }
    return null
  }

  async isConfigured(): Promise<boolean> {
    return (await this.resolve()) != null
  }
}

export const emailTransportRegistry = new EmailTransportRegistry()

/** Whether any registered transport can currently deliver email. */
export async function isEmailDeliveryConfigured(): Promise<boolean> {
  return await emailTransportRegistry.isConfigured()
}

/** Sends through the first configured transport; throws 503 when none is configured. */
export async function sendEmail(input: EmailInput): Promise<void> {
  const transport = await emailTransportRegistry.resolve()
  if (!transport) {
    throw new HttpError(503, 'Email delivery is not configured.')
  }
  await transport.send(input)
}

// Built-in Cloudflare transport — the cloud email path. It is treated as
// unconfigured in self-hosted builds so OSS email delivery (and features gated on
// it, like password reset) depend solely on the operator's own SMTP setup, even
// if stray CLOUDFLARE_EMAIL_* env happens to be present.
emailTransportRegistry.register({
  name: 'cloudflare',
  isConfigured: () => !isSelfHostedDeployment() && isCloudflareEmailConfigured(),
  send: (input) => sendCloudflareEmail(input)
})
