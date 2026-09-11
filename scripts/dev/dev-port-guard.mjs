/**
 * Refuse a second host-mode dev stack before its partial watchers can disturb the first one.
 *
 * Devkit assigns fixed web/API ports and publishes the web port through a fixed proxy route. Those
 * ports are therefore identities, not preferences: silently walking to another port starts a stack
 * the advertised hostname cannot reach. The bind probe is intentionally limited to the two services
 * this runner always starts; a remote/container slicer may legitimately own its assigned port.
 */
import { createServer } from 'node:net'

/** Fail with an actionable message when this checkout's fixed host-mode ports are already owned. */
export async function assertHostDevPortsAvailable(hostMode, options = {}) {
  if (!hostMode) return
  const isPortAvailable = options.isPortAvailable ?? canBindPort
  const assigned = [
    { name: 'web', port: hostMode.ports.web },
    { name: 'api', port: hostMode.ports.api }
  ]
  const availability = await Promise.all(assigned.map(async (service) => ({
    ...service,
    available: await isPortAvailable(service.port)
  })))
  const occupied = availability.filter((service) => !service.available)
  if (occupied.length === 0) return

  const ports = occupied.map((service) => `${service.name} ${service.port}`).join(', ')
  throw new Error(
    `another dev stack is already using this checkout's assigned port${occupied.length === 1 ? '' : 's'} (${ports})\n` +
    `       use the existing stack at ${hostMode.url}, or stop it before running npm run dev again`
  )
}

/** True only when a server can claim the port on the same IPv4 interface used in host mode. */
async function canBindPort(port) {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', (error) => {
      if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
        resolve(false)
        return
      }
      reject(error)
    })
    server.listen({ host: '0.0.0.0', port }, () => {
      server.close((error) => error ? reject(error) : resolve(true))
    })
  })
}
