/**
 * Validated debug-capture RPC commands for the bridge session.
 *
 * Capture state remains in `debug-capture.ts`; the runtime owns the RPC
 * envelope and cancellation lifecycle.
 */
import {
  bridgeDebugCaptureReadParamsSchema,
  bridgeDebugCaptureReadResultSchema,
  bridgeDebugCaptureStartParamsSchema,
  bridgeDebugCaptureStatusResultSchema,
  bridgeDebugCaptureStopParamsSchema
} from '@printstream/shared'
import { readCapture, startCapture, stopCapture } from './debug-capture.js'

type DebugCaptureRpcResult = { handled: true; result: unknown } | { handled: false }

/** Return a schema-checked result, or leave a different method to the runtime. */
export function handleDebugCaptureRpc(method: string, params: unknown): DebugCaptureRpcResult {
  switch (method) {
    case 'debug.capture.start': {
      const parsed = bridgeDebugCaptureStartParamsSchema.parse(params)
      return { handled: true, result: bridgeDebugCaptureStatusResultSchema.parse(startCapture(parsed)) }
    }
    case 'debug.capture.stop': {
      bridgeDebugCaptureStopParamsSchema.parse(params)
      return { handled: true, result: bridgeDebugCaptureStatusResultSchema.parse(stopCapture('manual')) }
    }
    case 'debug.capture.read': {
      bridgeDebugCaptureReadParamsSchema.parse(params)
      return { handled: true, result: bridgeDebugCaptureReadResultSchema.parse(readCapture()) }
    }
    default:
      return { handled: false }
  }
}
