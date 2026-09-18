/** Public Digital Asset Links document used by Android Credential Manager. */
import { Router } from 'express'
import { buildAndroidAssetLinks, type AndroidAssetLinkStatement } from '../lib/android-passkeys.js'

interface AndroidAssetLinksDependencies {
  statements(): AndroidAssetLinkStatement[]
}

const defaultDependencies: AndroidAssetLinksDependencies = {
  statements: buildAndroidAssetLinks
}

/** Create the unauthenticated well-known route with injectable data for tests. */
export function createAndroidAssetLinksRouter(
  dependencies: AndroidAssetLinksDependencies = defaultDependencies
): Router {
  const router = Router()
  router.get('/assetlinks.json', (_request, response) => {
    response.setHeader('Cache-Control', 'public, max-age=300')
    response.json(dependencies.statements())
  })
  return router
}

export const androidAssetLinksRouter = createAndroidAssetLinksRouter()
