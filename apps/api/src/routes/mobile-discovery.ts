/**
 * Unauthenticated product handshake for the Android wrapper. The shell calls
 * this before loading a remote origin into its bridge-enabled WebView, so the
 * response is intentionally bounded and carries no account or workspace data.
 */
import { Router } from 'express'
import {
  PRINTSTREAM_MOBILE_PROTOCOL_VERSION,
  mobileDiscoveryResponseSchema,
  type MobileDiscoveryResponse,
  type MobileNotificationTransport
} from '@printstream/shared'
import { deploymentKind, type DeploymentKind } from '../lib/deployment-mode.js'
import { getAppBuildInfo } from '../lib/app-build-info.js'
import { mobileNotificationTransport } from '../lib/mobile-notification-capability.js'
import { readRequestOrigin } from '../lib/request-helpers.js'

interface MobileDiscoveryDependencies {
  deployment(): DeploymentKind
  serverVersion(): string | null
  notificationTransport(): MobileNotificationTransport
}

const defaultDependencies: MobileDiscoveryDependencies = {
  deployment: deploymentKind,
  serverVersion: () => getAppBuildInfo().version ?? null,
  notificationTransport: mobileNotificationTransport
}

/** Build the public handshake, collapsing both self-hosted packaging modes. */
export function buildMobileDiscoveryResponse(
  canonicalOrigin: string,
  dependencies: MobileDiscoveryDependencies = defaultDependencies
): MobileDiscoveryResponse {
  return mobileDiscoveryResponseSchema.parse({
    product: 'printstream',
    protocolVersion: PRINTSTREAM_MOBILE_PROTOCOL_VERSION,
    nativeNavigationVersion: 1,
    canonicalOrigin: new URL(canonicalOrigin).origin,
    deployment: dependencies.deployment() === 'cloud' ? 'cloud' : 'selfHosted',
    serverVersion: dependencies.serverVersion(),
    nativeNotifications: {
      transport: dependencies.notificationTransport()
    }
  })
}

/** Create the well-known router with injectable discovery sources for tests. */
export function createMobileDiscoveryRouter(
  dependencies: MobileDiscoveryDependencies = defaultDependencies
): Router {
  const router = Router()
  router.get('/printstream-mobile.json', (request, response) => {
    const canonicalOrigin = readRequestOrigin(request)
    if (!canonicalOrigin) {
      response.status(400).json({ error: 'Host header is required.' })
      return
    }

    response.setHeader('Cache-Control', 'no-store')
    response.json(buildMobileDiscoveryResponse(canonicalOrigin, dependencies))
  })
  return router
}

export const mobileDiscoveryRouter = createMobileDiscoveryRouter()
