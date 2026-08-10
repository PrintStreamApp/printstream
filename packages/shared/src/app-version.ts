/**
 * Contract for the running app image's identity and (for the published
 * open-core image) whether a newer image is available on the container
 * registry. Consumed by the web footer to show the running build and, when
 * applicable, a subtle "update available" hint.
 *
 * Visibility is applied server-side: `revision` is null when there is nothing
 * to show (a source/dev run with no baked identity, or a viewer not permitted
 * to see the cloud image's version). `update` is null for any image that is
 * not the published open-core image, since only that image has a GHCR update
 * channel.
 */
import { z } from 'zod'

/**
 * - `current`: the running revision matches the registry's latest tag.
 * - `updateAvailable`: the registry's latest tag is a different build.
 * - `updatesLapsed`: a newer build exists, but this install's updates &
 *   support period has ended. The app keeps running the build it has — a
 *   perpetual license never stops working — so this is a renewal prompt, not
 *   an error. Only reachable on a licensed install whose key carries an
 *   `updatesUntil` in the past; community keys are perpetual and never lapse.
 * - `unknown`: the check has not completed or could not reach the registry.
 */
export const appUpdateStatusSchema = z.enum(['current', 'updateAvailable', 'updatesLapsed', 'unknown'])
export type AppUpdateStatusValue = z.infer<typeof appUpdateStatusSchema>

export const appUpdateInfoSchema = z.object({
  status: appUpdateStatusSchema,
  /** Git revision the registry's latest tag was built from, when known. */
  latestRevision: z.string().nullable(),
  /** Short form of `latestRevision` for display. */
  latestShortRevision: z.string().nullable(),
  /** ISO timestamp of the last completed registry check. */
  checkedAt: z.string().nullable(),
  /** Image reference an operator pulls to update (e.g. `ghcr.io/...:latest`). */
  imageRef: z.string().nullable(),
  /**
   * Where to GET the newer build, for channels that hand out a file rather than
   * an image to pull — today the native single-file app. Null on the Docker
   * channel, where `imageRef` is the answer. Kept as a separate field rather
   * than overloading `imageRef` because the two call for different copy: one is
   * a command to run, the other is a link to follow.
   */
  downloadUrl: z.string().nullable().default(null)
})
export type AppUpdateInfo = z.infer<typeof appUpdateInfoSchema>

export const appVersionResponseSchema = z.object({
  /** Full git revision the running image was built from; null when nothing to show. */
  revision: z.string().nullable(),
  /** Short form of `revision` for display. */
  shortRevision: z.string().nullable(),
  /** True when running from the published open-core image (has an update channel). */
  published: z.boolean(),
  /** Registry update status; null unless this is the published open-core image. */
  update: appUpdateInfoSchema.nullable(),
  /**
   * True when THIS VIEWER may apply the available update in place — only ever
   * true on the native single-file app, for a viewer with settings-manage
   * permission, while `update.status` is `updateAvailable` and a binary exists
   * for this platform. Drives the footer's one-click update; the server
   * re-checks permission on `POST /api/app/update/start`.
   */
  canApplyUpdate: z.boolean().default(false)
})
export type AppVersionResponse = z.infer<typeof appVersionResponseSchema>

/**
 * Response of `POST /api/app/update/start` when the update was accepted. Every
 * non-accepted outcome (already current, busy, unsigned build, licence refusal)
 * is an HTTP error whose message says why, so this shape only ever means "the
 * app is restarting into the new build".
 */
export const appUpdateStartResponseSchema = z.object({
  accepted: z.literal(true),
  message: z.string()
})
export type AppUpdateStartResponse = z.infer<typeof appUpdateStartResponseSchema>

/** Nothing-to-show payload (dev/source run, or viewer not permitted). */
export const EMPTY_APP_VERSION_RESPONSE: AppVersionResponse = {
  revision: null,
  shortRevision: null,
  published: false,
  update: null,
  canApplyUpdate: false
}
