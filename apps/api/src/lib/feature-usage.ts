/**
 * Feature-usage recording seam. A deployment-specific module (the cloud's
 * telemetry recorder, `src/private/cloud/feature-usage/`) may register one
 * recorder that receives a small attribution sample for each completed
 * workspace-scoped API request; {@link installFeatureUsageCapture} feeds it.
 * Self-hosted/OSS builds register nothing, so the middleware passes requests
 * through untouched — exactly like the plugin plan-gate registry this mirrors.
 *
 * Contract: recording is strictly best-effort and must never affect request
 * handling — the recorder is invoked after the response has finished, a
 * recorder error is logged and swallowed, and the sample deliberately carries
 * no body, query, or header data (attribution only: who-ish, where, outcome).
 * Which samples *mean* anything (mutations vs reads, which paths map to which
 * features) is the recorder's decision, not core's.
 */
import type { NextFunction, Request, Response } from 'express'

export interface FeatureUsageSample {
  workspaceId: string
  actorType: 'user' | 'service-account'
  method: string
  /** The request path as received (`request.path`) — not the matched route pattern. */
  path: string
  statusCode: number
}

export type FeatureUsageRecorder = (sample: FeatureUsageSample) => void

let recorder: FeatureUsageRecorder | null = null

/** Register the deployment's recorder (pass null to clear — tests only). */
export function registerFeatureUsageRecorder(next: FeatureUsageRecorder | null): void {
  recorder = next
}

/**
 * Express middleware feeding the registered recorder. Snapshots attribution
 * before `next()` (the request object mutates during routing) and reports on
 * `finish` so recording can never delay a response. Anonymous and
 * non-workspace requests are skipped here: platform-admin traffic is not
 * workspace feature usage, and unauthenticated requests have no one to
 * attribute to.
 */
export function installFeatureUsageCapture() {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!recorder) {
      next()
      return
    }
    const workspaceId = request.workspace?.id ?? null
    const actor = request.auth.actor
    if (!workspaceId || actor.type === 'anonymous') {
      next()
      return
    }
    const snapshot = {
      workspaceId,
      actorType: actor.type,
      method: request.method,
      path: request.path
    }
    response.on('finish', () => {
      try {
        recorder?.({ ...snapshot, statusCode: response.statusCode })
      } catch (error) {
        console.warn('[feature-usage] recorder failed; ignoring', { error })
      }
    })
    next()
  }
}
