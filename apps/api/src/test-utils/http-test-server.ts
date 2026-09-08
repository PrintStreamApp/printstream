/**
 * Test-only helper that binds a request handler to an ephemeral loopback port
 * for the duration of one test and then takes it down deterministically.
 *
 * Contract: `run` receives the base URL (`http://127.0.0.1:<port>`) and the
 * server is closed before this resolves, whether `run` succeeded or threw.
 *
 * The invariant worth having a helper for is the teardown. `server.close()`
 * stops the listener but WAITS for open connections, and the keep-alive sockets
 * `fetch` leaves behind are not all released by `closeIdleConnections()`: a
 * response written by streaming into it (`pipeline(fileStream, response)`)
 * leaves its connection counted as active rather than idle, so `close()` alone
 * blocks until a client-side timer fires, measured at 3.0 seconds per streamed
 * download. A suite that binds a server per test pays that per test, so tear
 * the connections down outright. That is safe because the test has already
 * awaited every response it asserts on, and it is what `src/index.ts` does on
 * shutdown for the same reason.
 */
import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

export async function withEphemeralServer(
  handler: RequestListener,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await closeEphemeralServer(server)
  }
}

/**
 * Tears down a server the caller created itself, applying the same rule.
 *
 * Exported because a stub that must hand back its own control handles (queued requests, a way to
 * release a pending response) cannot be expressed as a `run` callback. Five of the six teardowns in
 * `slicer-client.test.ts` had already drifted to a bare `close()`, which is the drift this prevents.
 */
export async function closeEphemeralServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
