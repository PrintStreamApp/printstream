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
   * Printer allowance this key grants; `null` = unlimited.
   *
   * For self-hosted Pro this is the metered count, and it moves: the install
   * ASKS for a new total (`/api/license/entitlement`), the cloud bills the
   * difference, and the answer comes back as a re-signed key carrying the new
   * value. The install never reports its fleet and is never trusted to — the
   * number is only ever what someone paid for.
   */
  maxPrinters: z.number().int().positive().nullable().default(null),
  /**
   * Which deployment issued this key, and therefore where the install refreshes
   * it. Absent on keys issued before this field existed, and on any key whose
   * issuer did not know its own public URL; callers fall back to the vendor
   * cloud, which is what those keys have always used.
   *
   * Signed rather than configured because the alternative is an install pointed
   * at the wrong deployment by a local setting — a refresh that fails silently
   * and only surfaces weeks later, when the run window lapses on a key that was
   * never actually renewable. A key knowing its own home cannot drift from it.
   *
   * NOT a trust decision: the origin is only readable once the signature has
   * already been verified against the embedded vendor key, so it selects where
   * to talk, never whether to believe. A build trusts exactly one signer.
   */
  refreshOrigin: z.string().url().optional()
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
  maxPrinters: z.number().int().nullable(),
  /**
   * True when a live self-hosted subscription meters this key, so adding a
   * printer past `maxPrinters` raises the entitlement and CHARGES rather than
   * being refused.
   *
   * Surfaced because a silent price increase is a trust (and chargeback)
   * problem: the add dialog has to be able to say what the add will cost before
   * the form is filled in. Derived from the installed token, not from a cloud
   * round-trip, so it is still right on an install that cannot reach us.
   */
  metered: z.boolean()
})
export type LicenseStatus = z.infer<typeof licenseStatusSchema>

/**
 * Self-hosted license enforcement state. Applies to every self-hosted build —
 * native *and* Docker/OSS — since PolyForm Noncommercial already forbids the
 * commercial use being gated; the multi-workspace cloud licenses via subscriptions
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
  enforcement: licenseEnforcementSchema,
  /**
   * Printers on this INSTALL, across every workspace — the same count the cap is
   * enforced against (`printer-quota.ts` counts install-wide, because counting
   * per workspace would let anyone lift the cap by making a second one).
   *
   * Reported so the add-printer notice can say whether the next add will bill,
   * without the browser re-deriving a number from a workspace-scoped list that
   * would be wrong on a multi-workspace install.
   */
  printerCount: z.number().int().nonnegative()
})
export type LicenseStatusResponse = z.infer<typeof licenseStatusResponseSchema>

/**
 * Result of an operator-triggered "check for license updates" (`POST
 * /api/license/check`). `skipped` means there was nothing to check — no key
 * installed, or a perpetual one that never phones home.
 */
export const licenseCheckResponseSchema = licenseStatusResponseSchema.extend({
  outcome: z.enum(['skipped', 'unchanged', 'renewed', 'revoked', 'failed'])
})
export type LicenseCheckResponse = z.infer<typeof licenseCheckResponseSchema>

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
  key: z.string().trim().min(1).max(4000),
  /**
   * The install asking. A licence covers ONE installation, so the first refresh
   * to present a key claims it and later ones from a DIFFERENT install are
   * refused — without this, each install counted only its own printers against
   * the same entitlement, so a 3-printer licence quietly became 3 per install.
   *
   * Optional: an install that predates this still refreshes, it simply does not
   * claim the binding. Treat it as a secret like the key itself — never log it.
   */
  installationId: z.string().trim().min(1).max(200).optional()
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

/**
 * Self-hosted → cloud request to change how many printers a licence covers.
 *
 * The install does not decide its own entitlement — it asks, the cloud bills the
 * difference, and the answer comes back signed into a new key. That is the whole
 * reason this is a network call rather than a local setting: the enforcement
 * code that reads `maxPrinters` ships in the open-source build, so a locally
 * chosen number would mean nothing.
 *
 * Same credential model as refresh: the installed key IS the credential.
 * Counterpart: `apps/api/src/private/cloud/license-entitlement.ts`.
 */
export const licenseEntitlementRequestSchema = z.object({
  key: z.string().trim().min(1).max(4000),
  /** Required here, unlike refresh: a billing change must name the install it is for. */
  installationId: z.string().trim().min(1).max(200),
  /**
   * The TOTAL the install wants to be entitled to, never a delta — a retried
   * request after a lost response must not bill a second time.
   */
  printers: z.number().int().min(1).max(1000)
})
export type LicenseEntitlementRequest = z.infer<typeof licenseEntitlementRequestSchema>

export const licenseEntitlementResponseSchema = z.object({
  /**
   * `applied` — billing changed and `key` carries the new allowance.
   * `unchanged` — the subscription already covered this many.
   * `refused` — `message` says why (no subscription, not this install's key,
   * payment declined); the install keeps the entitlement it had.
   */
  outcome: z.enum(['applied', 'unchanged', 'refused']),
  key: z.string().nullable(),
  /** The allowance now in force, so the install can report it without re-parsing the key. */
  maxPrinters: z.number().int().nullable(),
  message: z.string().nullable()
})
export type LicenseEntitlementResponse = z.infer<typeof licenseEntitlementResponseSchema>

/**
 * A self-hosted install asking the vendor for a free community key, with no
 * account and nothing but an address to send it to.
 *
 * CORE, not private-cloud: the OSS build is the CALLER, so the public snapshot
 * has to speak this shape. The cloud side that answers it is private.
 *
 * The email is the whole identity. It is never verified before the key is
 * issued, because the key is DELIVERED to it — possession of the inbox is the
 * proof, and a confirmation round trip would only add a step to the same
 * outcome.
 */
export const communityLicenseRequestSchema = z.object({
  email: z.string().trim().email('Enter the email address to send the key to.').max(320),
  /** Who the licence is made out to. Defaults to the address when omitted. */
  licensee: z.string().trim().min(1).max(120).optional(),
  /**
   * The non-commercial terms. A literal `true` rather than a boolean: a client
   * that forgets the field must fail, not silently request on someone's behalf.
   */
  agreedToTerms: z.literal(true)
})
export type CommunityLicenseRequest = z.infer<typeof communityLicenseRequestSchema>

/**
 * Deliberately says only that a delivery was attempted.
 *
 * Never reports whether the address already had a key, or an account: this
 * endpoint is unauthenticated, so a caller-visible difference would turn it
 * into an oracle for which addresses are registered.
 */
export const communityLicenseResponseSchema = z.object({
  delivered: z.literal(true)
})
export type CommunityLicenseResponse = z.infer<typeof communityLicenseResponseSchema>
