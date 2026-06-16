/**
 * API-side camera access for bridge-owned printers.
 *
 * Thin wrapper that resolves a printer's bridge assignment and delegates camera
 * snapshots and frame streaming to that bridge over the WS RPC session (the
 * actual capture lives in `@printstream/bridge-runtime`). `streamFrames` adapts
 * the bridge's push-based frame subscription into an abortable async generator.
 */
import { bridgeCameraSnapshotResultSchema, type Printer } from '@printstream/shared'
import { supportsChamberCamera } from '@printstream/bridge-runtime'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { bridgeUnavailableMessage } from './managed-bridge.js'
import { printerManager } from './printer-manager.js'

export { supportsChamberCamera }

export async function fetchSnapshot(printer: Printer): Promise<Buffer> {
	if (!supportsChamberCamera(printer.model)) {
		throw new Error(`Camera not supported for model ${printer.model}`)
	}

	const bridgeId = printerManager.getBridgeId(printer.id)
	if (!bridgeId) {
		throw new Error('Camera access requires a connected bridge assignment')
	}
	if (!bridgeSessionManager.isConnected(bridgeId)) {
		throw new Error(bridgeUnavailableMessage())
	}

	const result = bridgeCameraSnapshotResultSchema.parse(await bridgeSessionManager.requestRpc(bridgeId, 'camera.snapshot', {
		printer
	}))
	return Buffer.from(result.jpegBase64, 'base64')
}

export async function* streamFrames(printer: Printer, signal?: AbortSignal): AsyncGenerator<Buffer, void, void> {
	if (!supportsChamberCamera(printer.model)) {
		throw new Error(`Camera not supported for model ${printer.model}`)
	}

	const bridgeId = printerManager.getBridgeId(printer.id)
	if (!bridgeId) {
		throw new Error('Camera access requires a connected bridge assignment')
	}
	if (!bridgeSessionManager.isConnected(bridgeId)) {
		throw new Error(bridgeUnavailableMessage())
	}

	type StreamItem = { frame: Buffer } | { error: Error }
	const queue: StreamItem[] = []
	let resume: (() => void) | null = null

	const push = (item: StreamItem) => {
		queue.push(item)
		resume?.()
		resume = null
	}

	const unsubscribe = bridgeSessionManager.subscribeCameraFrames(bridgeId, printer.id, {
		onFrame(frame) {
			push({ frame })
		},
		onClose(error) {
			push({ error })
		}
	})

	const onAbort = () => {
		const error = new Error('The operation was aborted')
		error.name = 'AbortError'
		push({ error })
	}
	signal?.addEventListener('abort', onAbort, { once: true })

	try {
		for (;;) {
			if (queue.length === 0) {
				await new Promise<void>((resolve) => {
					resume = resolve
				})
			}

			const next = queue.shift()
			if (!next) continue
			if ('error' in next) {
				if (next.error.name === 'AbortError') {
					return
				}
				throw next.error
			}

			yield next.frame
		}
	} finally {
		signal?.removeEventListener('abort', onAbort)
		unsubscribe()
	}
}
