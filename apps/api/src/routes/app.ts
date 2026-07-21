/**
 * Running-app identity for the web footer: the build the image was made from
 * and, for the published open-core image, whether a newer image is available
 * on GHCR. Visibility is applied here (see `resolveAppVersionPayload`): the
 * published image is shown to everyone; the cloud image's version is shown to
 * platform users only; a source/dev run shows nothing.
 */
import { Router } from 'express'
import { appVersionResponseSchema } from '@printstream/shared'
import { getAppBuildInfo, resolveAppVersionPayload } from '../lib/app-build-info.js'
import { getAppUpdateInfo } from '../lib/app-update-check.js'
import { areUpdatesEntitled } from '../lib/license-entitlements.js'

export const appRouter = Router()

appRouter.get('/version', async (request, response) => {
  const isPlatformUser = request.auth.actor.type === 'user' && request.auth.actor.isPlatformUser === true
  const update = getAppUpdateInfo()
  // The registry check answers "is there a newer build"; the license answers
  // "may this install take it". Kept apart on purpose — `app-update-check.ts`
  // stays a pure registry reader, and the entitlement is applied once, here at
  // the boundary. Only `updateAvailable` is rewritten: a lapsed addon is a
  // renewal prompt on an available update, never a claim of being up to date.
  const entitledUpdate = update && update.status === 'updateAvailable' && !(await areUpdatesEntitled())
    ? { ...update, status: 'updatesLapsed' as const }
    : update
  const payload = resolveAppVersionPayload({
    build: getAppBuildInfo(),
    isPlatformUser,
    update: entitledUpdate
  })
  response.json(appVersionResponseSchema.parse(payload))
})
