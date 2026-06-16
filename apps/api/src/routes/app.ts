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

export const appRouter = Router()

appRouter.get('/version', (request, response) => {
  const isPlatformUser = request.auth.actor.type === 'user' && request.auth.actor.isPlatformUser === true
  const payload = resolveAppVersionPayload({
    build: getAppBuildInfo(),
    isPlatformUser,
    update: getAppUpdateInfo()
  })
  response.json(appVersionResponseSchema.parse(payload))
})
