/**
 * Running-app identity for the web footer: the build the image was made from
 * and, for the published open-core image, whether a newer image is available
 * on GHCR. Visibility is applied here (see `resolveAppVersionPayload`): the
 * product SemVer is shown to everyone, while exact cloud revisions remain
 * visible only to platform users.
 *
 * Also the web's trigger for the native app's one-click in-place update
 * (`POST /update/start`): a twin of the bridges' `update/start` action, gated
 * on the same settings-manage permission, executed in-process by
 * `native-update-apply.ts`. Counterpart: `AppVersionFooter.tsx`.
 */
import { Router } from 'express'
import { appUpdateStartResponseSchema, appVersionResponseSchema, SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { getAppBuildInfo, resolveAppVersionPayload } from '../lib/app-build-info.js'
import { getAppUpdateInfo } from '../lib/app-update-check.js'
import type { Request } from 'express'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { assertRequestPermission, requireRequestPermission } from '../lib/authorization.js'
import { conflict } from '../lib/http-error.js'
import { areUpdatesEntitled } from '../lib/license-entitlements.js'
import { isNativeDeployment } from '../lib/deployment-mode.js'
import { applyNativeUpdate } from '../lib/native-update-apply.js'
import { getNativeUpdateInfo } from '../lib/native-update-check.js'

export const appRouter = Router()

appRouter.get('/version', async (request, response) => {
  const isPlatformUser = request.auth.actor.type === 'user' && request.auth.actor.isPlatformUser === true
  const native = isNativeDeployment()
  // Two channels, one shape: the native app asks the live server's release
  // manifest, the published Docker image asks the registry. Exactly one is ever
  // active in a given process.
  const update = native ? getNativeUpdateInfo() : getAppUpdateInfo()
  // The registry check answers "is there a newer build"; the license answers
  // "may this install take it". Kept apart on purpose: `app-update-check.ts`
  // stays a pure registry reader, and the entitlement is applied once, here at
  // the boundary. Only `updateAvailable` is rewritten: a lapsed addon is a
  // renewal prompt on an available update, never a claim of being up to date.
  const entitledUpdate = update && update.status === 'updateAvailable' && !(await areUpdatesEntitled())
    ? { ...update, status: 'updatesLapsed' as const }
    : update
  const payload = resolveAppVersionPayload({
    build: getAppBuildInfo(),
    isPlatformUser,
    update: entitledUpdate,
    native,
    // Advisory for the footer button; POST /update/start re-checks it.
    canApplyUpdate: native && viewerMayApplyUpdate(request)
  })
  response.json(appVersionResponseSchema.parse(payload))
})

/**
 * Whether THIS viewer would clear the update endpoint's permission gate. The
 * same assert the POST runs, not a bare permission-list check, because a
 * fresh native install runs with auth disabled, where enforcement is bypassed
 * rather than permissions granted; a raw list check would hide the button from
 * exactly the operator the endpoint would accept.
 */
function viewerMayApplyUpdate(request: Request): boolean {
  try {
    assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)
    return true
  } catch {
    return false
  }
}

/**
 * One-click in-place update of the native app. Accepted means the process is
 * about to restart into the new build: the caller should expect the
 * connection to drop and poll `/version` until the revision changes. Every
 * refusal (already current, busy, unsigned build, licence refusal, backup
 * failure) is a 409 whose message says why.
 */
appRouter.post('/update/start', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const result = await applyNativeUpdate()
  annotateRequestAuditLog(request, {
    action: 'app.update.start',
    resource: 'app',
    summary: result.accepted ? 'Started a native app update' : `Native app update refused: ${result.status}`,
    metadata: { status: result.status }
  })
  if (!result.accepted) throw conflict(result.message)
  response.status(202).json(appUpdateStartResponseSchema.parse({ accepted: true, message: result.message }))
})
