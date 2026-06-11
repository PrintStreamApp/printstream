/**
 * Waits for the PostgreSQL host in DATABASE_URL to accept TCP connections.
 * Used by the devcontainer and local setup scripts before running Prisma.
 */
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.')
}

const parsedUrl = new URL(databaseUrl)
const host = parsedUrl.hostname
const port = Number(parsedUrl.port || '5432')
const timeoutMs = Number(process.env.DB_WAIT_TIMEOUT_MS || '60000')
const retryDelayMs = Number(process.env.DB_WAIT_RETRY_MS || '1000')
const deadline = Date.now() + timeoutMs

function probe() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })

    socket.once('connect', () => {
      socket.end()
      resolve()
    })

    socket.once('error', (error) => {
      socket.destroy()
      reject(error)
    })
  })
}

while (Date.now() < deadline) {
  try {
    await probe()
    process.stdout.write(`Database is reachable at ${host}:${port}.\n`)
    process.exit(0)
  } catch {
    await delay(retryDelayMs)
  }
}

throw new Error(`Timed out waiting for database at ${host}:${port}.`)
