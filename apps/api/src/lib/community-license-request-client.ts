/**
 * Asking the vendor for a free community key, on behalf of this install.
 *
 * The install makes this call, not the browser. The operator's browser may sit
 * on a segment with no route out (a print farm on an isolated VLAN is the norm,
 * not the exception), while the server already reaches the vendor for key
 * refresh — so the half of the system that is known to have egress is the half
 * that asks. It also keeps the vendor endpoint free of CORS.
 *
 * There is no key installed yet, by definition, so the origin cannot come from
 * one: `resolveLicenseRefreshOrigin(null)` yields the default vendor origin
 * unless an operator has deliberately overridden it.
 *
 * Counterpart: `apps/api/src/private/cloud/community-license-request.ts`.
 */
import {
  communityLicenseResponseSchema,
  type CommunityLicenseRequest
} from '@printstream/shared'
import { resolveLicenseRefreshOrigin } from './license-origin.js'

export type CommunityLicenseRequestOutcome =
  | { ok: true }
  | { ok: false; message: string }

/**
 * @returns whether the vendor accepted the request. Never throws: every failure
 * here is something the operator needs shown, not a 500.
 *
 * A refusal carries the vendor's own message when there is one — it is the side
 * that knows why (rate limited, issuance switched off) and its wording will
 * outlive any guess made here.
 */
export async function requestCommunityLicense(
  input: CommunityLicenseRequest
): Promise<CommunityLicenseRequestOutcome> {
  const origin = resolveLicenseRefreshOrigin(null)
  try {
    const response = await fetch(new URL('/api/licenses/community', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      const message = await readErrorMessage(response)
      console.warn('[license] community key request refused', { status: response.status, origin })
      return { ok: false, message }
    }
    if (!communityLicenseResponseSchema.safeParse(await response.json()).success) {
      console.warn('[license] community key response did not match the expected shape', { origin })
      return { ok: false, message: 'The licensing service returned an unexpected response. Try again shortly.' }
    }
    return { ok: true }
  } catch (error) {
    // An install with no internet access is the ordinary case here, not a bug,
    // so it gets a sentence that says what to do rather than a stack trace.
    console.warn('[license] could not reach the licensing service', { origin, error })
    return {
      ok: false,
      message: 'Could not reach the licensing service. Check this machine\'s internet access, or request a key from printstream.app and paste it below.'
    }
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return body.error
    }
  } catch {
    // Falls through to the generic message below.
  }
  return response.status === 429
    ? 'Too many requests from this network. Wait a few minutes and try again.'
    : 'The licensing service could not issue a key just now. Try again shortly.'
}
