/**
 * Self-hosted license token contract (public/core). A license key is a compact,
 * signed token: `PSL1.<base64url(payload)>.<base64url(ed25519 signature)>`. The
 * vendor's cloud signs with a private key; every build verifies with an embedded
 * public key (so keys can be verified but never forged, and no secret ships in
 * OSS). See `apps/api/src/lib/license.ts` for the crypto.
 */
import { z } from 'zod'

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
   * Updates & priority support are included until this unix time (commercial
   * licenses). `null` means perpetual — used for community keys, which never
   * expire (the app keeps working; the license only attests non-commercial use).
   */
  updatesUntil: z.number().int().nonnegative().nullable()
})
export type LicensePayload = z.infer<typeof licensePayloadSchema>

/** Public-facing license status derived from a verified (or absent) key. */
export const licenseStatusSchema = z.object({
  edition: licenseEditionSchema.nullable(),
  licensee: z.string().nullable(),
  /** True when a valid, correctly-signed key is installed. */
  valid: z.boolean(),
  /** True when updates/support have lapsed (commercial only). */
  updatesExpired: z.boolean(),
  updatesUntil: z.number().int().nullable()
})
export type LicenseStatus = z.infer<typeof licenseStatusSchema>

/**
 * Native-build license enforcement state. The native (paid) distribution
 * requires a commercial license: fresh installs get an evaluation window, after
 * which printer adds and print dispatch lock until a commercial key is entered.
 * Docker/OSS installs are always `unrestricted` (community or commercial keys
 * are an honor-system statement there, not a gate).
 */
export const nativeLicenseEnforcementSchema = z.object({
  /** True when running inside the native (paid) distribution. */
  native: z.boolean(),
  mode: z.enum(['unrestricted', 'evaluation', 'limited']),
  /** When the evaluation window ends/ended (native evaluation or limited mode). */
  graceEndsAt: z.string().datetime().nullable()
})
export type NativeLicenseEnforcement = z.infer<typeof nativeLicenseEnforcementSchema>

export const licenseStatusResponseSchema = z.object({
  status: licenseStatusSchema,
  enforcement: nativeLicenseEnforcementSchema
})
export type LicenseStatusResponse = z.infer<typeof licenseStatusResponseSchema>

/** Install a license key on a self-hosted deployment. */
export const setLicenseRequestSchema = z.object({
  key: z.string().trim().min(1, 'A license key is required.').max(4000)
})
export type SetLicenseRequest = z.infer<typeof setLicenseRequestSchema>
