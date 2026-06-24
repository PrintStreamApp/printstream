/**
 * Distinguishes the self-hosted (open-source) deployment from the hosted cloud
 * deployment. This drives build-exclusive behavior — most importantly which
 * built-in auth provider is registered: self-hosted runs `auth-password`
 * (email/password, no email infrastructure required), cloud runs `auth-local`
 * (passkeys + one-time email codes via Cloudflare email).
 *
 * The default is derived from the build itself: the private cloud modules under
 * `src/private` are stripped from the public OSS export, so their absence means
 * self-hosted. `SELF_HOSTED` overrides the derivation (e.g. set it when running
 * the full private tree from source to exercise the OSS path locally).
 */
import { env } from './env.js'
import { hasPrivateModules } from './private-modules.js'

export function isSelfHostedDeployment(): boolean {
  return env.SELF_HOSTED ?? !hasPrivateModules()
}
