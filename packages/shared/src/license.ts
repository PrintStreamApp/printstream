/**
 * Self-hosted license token contract (public/core). A license key is a compact,
 * signed token: `PSL1.<base64url(payload)>.<base64url(ed25519 signature)>`. The
 * vendor's cloud signs with a private key; every build verifies with an embedded
 * public key (so keys can be verified but never forged, and no secret ships in
 * OSS). See `apps/api/src/lib/license.ts` for the verifying crypto — the signing
 * half is cloud-only and deliberately absent from every shipped build.
 *
 * Two independent clocks ride in the payload and are routinely confused:
 * `expiresAt` is the **right to run** (a Pro subscription's key dies when the
 * subscription does), while `updatesUntil` is the **right to newer builds and
 * priority support** (the annual addon on a perpetual Lifetime key). A lapsed
 * `updatesUntil` never stops the app; a passed `expiresAt` does.
 *
 * **The payload is a persisted wire format.** Keys already in customers' hands
 * are parsed by whatever build they are running, so every field added after v1
 * shipped must be optional with a back-compatible default — a key issued before
 * the field existed has to keep verifying, and must read as the pre-field
 * behaviour (perpetual, unlimited). Adding a *required* field, or a new
 * `edition` enum member, silently invalidates existing keys on older installs,
 * which reject the whole payload rather than the unknown part. Widening the
 * enum needs a `v: 2` token and a transition window, not a drive-by edit.
 */
import { z } from 'zod'

/**
 * What the key permits. `commercial` covers business use — held both by a
 * Lifetime purchase and by a Pro subscription's self-hosted key; the two are
 * told apart by `expiresAt` (null = perpetual Lifetime), not by a distinct
 * edition, precisely because older builds would reject an unknown enum member.
 */
export const licenseEditionSchema = z.enum(['community', 'commercial'])
export type LicenseEdition = z.infer<typeof licenseEditionSchema>

export const licensePayloadSchema = z.object({
  /** Token format version. */
  v: z.literal(1),
  /** Opaque license id (for renewals, revocation lookup, and support). */
  id: z.string().min(1),
  edition: licenseEditionSchema,
  /** Who the license was issued to (name / email / organization). */
  licensee: z.string().min(1),
  /** Issue time, unix seconds. */
  issuedAt: z.number().int().nonnegative(),
  /**
   * Updates & priority support are included until this unix time. `null` means
   * perpetual — community keys, which only attest non-commercial use. Lapsing
   * blocks *updates and support surfaces*, never the app itself.
   */
  updatesUntil: z.number().int().nonnegative().nullable(),
  /**
   * The right to run ends at this unix time. `null` = perpetual (a Lifetime
   * purchase, a community key, or any key issued before this field existed).
   * Subscription-backed keys carry a rolling window well beyond the billing
   * period and are re-issued by the refresh endpoint while the subscription
   * lives, so the window is a dead-man's switch, not a renewal deadline.
   */
  expiresAt: z.number().int().nonnegative().nullable().default(null),
  /**
   * Printer allowance this key grants; `null` = unlimited. Self-hosted Pro is
   * metered on a count declared at checkout and signed in here, because the
   * vendor cannot see a self-hosted install's fleet and deliberately does not
   * ask it to report one.
   */
  maxPrinters: z.number().int().positive().nullable().default(null)
})
export type LicensePayload = z.infer<typeof licensePayloadSchema>

/** Public-facing license status derived from a verified (or absent) key. */
export const licenseStatusSchema = z.object({
  edition: licenseEditionSchema.nullable(),
  licensee: z.string().nullable(),
  /**
   * True when a correctly-signed key is installed AND still within `expiresAt`.
   * An expired key reads `valid: false` with `expired: true`, so callers that
   * only check `valid` fail closed.
   */
  valid: z.boolean(),
  /** True when a correctly-signed key is installed but its run window has passed. */
  expired: z.boolean(),
  /** When the right to run ends; null = perpetual. Unix seconds. */
  expiresAt: z.number().int().nullable(),
  /** True when updates/support have lapsed. Does not affect `valid`. */
  updatesExpired: z.boolean(),
  updatesUntil: z.number().int().nullable(),
  /** Printer allowance granted by the key; null = unlimited. */
  maxPrinters: z.number().int().nullable()
})
export type LicenseStatus = z.infer<typeof licenseStatusSchema>

/**
 * Self-hosted license enforcement state. Applies to every self-hosted build —
 * native *and* Docker/OSS — since PolyForm Noncommercial already forbids the
 * commercial use being gated; the multi-tenant cloud licenses via subscriptions
 * instead and is always `unrestricted`.
 *
 * A fresh (or newly-upgraded) install gets an evaluation window, after which
 * printer adds and print dispatch lock until a key is entered. Existing
 * printers stay visible and data is never locked away.
 *
 * The two builds differ only in which editions satisfy them: Docker/OSS accepts
 * a community key (non-commercial use is free there), the native paid app
 * requires `commercial`.
 */
export const licenseEnforcementSchema = z.object({
  /** True when this build enforces a license at all (false in the cloud). */
  enforced: z.boolean(),
  /** True when running inside the native (paid) distribution. */
  native: z.boolean(),
  /**
   * `unrestricted` — licensed, or not an enforcing build.
   * `evaluation` — inside the initial window; fully functional.
   * `limited` — window elapsed with no sufficient key; adds/dispatch blocked.
   */
  mode: z.enum(['unrestricted', 'evaluation', 'limited']),
  /** When the evaluation window ends/ended (evaluation or limited mode). */
  graceEndsAt: z.string().datetime().nullable()
})
export type LicenseEnforcement = z.infer<typeof licenseEnforcementSchema>

export const licenseStatusResponseSchema = z.object({
  status: licenseStatusSchema,
  enforcement: licenseEnforcementSchema
})
export type LicenseStatusResponse = z.infer<typeof licenseStatusResponseSchema>

/** Install a license key on a self-hosted deployment. */
export const setLicenseRequestSchema = z.object({
  key: z.string().trim().min(1, 'A license key is required.').max(4000)
})
export type SetLicenseRequest = z.infer<typeof setLicenseRequestSchema>

/**
 * Self-hosted → cloud license refresh. The installed key authenticates the
 * request (it is the only credential a self-hosted install holds), and the
 * vendor answers with a re-signed key carrying a fresh `expiresAt` while the
 * backing subscription is alive. Counterpart: the cloud's refresh route in
 * `apps/api/src/private/cloud/license-refresh.ts`.
 */
export const licenseRefreshRequestSchema = z.object({
  key: z.string().trim().min(1).max(4000)
})
export type LicenseRefreshRequest = z.infer<typeof licenseRefreshRequestSchema>

export const licenseRefreshResponseSchema = z.object({
  /**
   * `renewed` — use `key`. `unchanged` — the installed key is still current.
   * `revoked` — the backing subscription ended; the install should stop
   * refreshing and let the current key run out its window.
   */
  outcome: z.enum(['renewed', 'unchanged', 'revoked']),
  key: z.string().nullable(),
  /** Operator-facing explanation, shown in the license settings surface. */
  message: z.string().nullable()
})
export type LicenseRefreshResponse = z.infer<typeof licenseRefreshResponseSchema>
