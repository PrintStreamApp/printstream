/**
 * Contract for the live server's native-build release channel: which native
 * (single-file) server build is current, and where an install downloads it.
 *
 * Served by the cloud's `/api/server-runtime/releases` (private,
 * `apps/api/src/private/cloud/server-release-channel.ts`) and consumed by the
 * core polling client + apply driver in `apps/api/src/lib/native-update-*.ts`
 * — a cross-process payload, so both sides go through this schema rather than
 * hand-written field lists.
 *
 * Builds are content-addressed by release fingerprint (no semver, equality
 * only), exactly like the bridge channel. `sha256`/`signature` are nullable
 * because releases published before signed fragments existed still resolve;
 * the APPLY side refuses those, while the notify side works regardless.
 */
import { z } from 'zod'

export const serverReleaseBinarySchema = z.object({
  /** Licensed download endpoint on the live server, never a GitHub URL. */
  url: z.string(),
  /** Size of the executable as published (assets are uncompressed). */
  sizeBytes: z.number().int().nonnegative(),
  /** Hex sha256 of the executable; null for pre-fragment releases. */
  sha256: z.string().nullable().default(null),
  /** Ed25519 signature (base64) over the sha256 hex; null for pre-fragment releases. */
  signature: z.string().nullable().default(null)
})
export type ServerReleaseBinary = z.infer<typeof serverReleaseBinarySchema>

export const serverReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  /** The build the deploy promoted; null until a native release is promoted. */
  current: z.object({
    fingerprint: z.string(),
    releasedAt: z.string(),
    /** Keyed by platform, e.g. `linux-x64`, `win32-x64`. */
    binaries: z.record(serverReleaseBinarySchema)
  }).nullable()
})
export type ServerReleaseManifest = z.infer<typeof serverReleaseManifestSchema>
