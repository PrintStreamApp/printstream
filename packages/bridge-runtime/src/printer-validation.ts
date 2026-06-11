import mqtt from 'mqtt'
import net from 'node:net'
import type {
  PrinterConnectionValidation,
  PrinterConnectionValidationInput,
  PrinterConnectionWarning
} from '@printstream/shared'

const MQTT_PORT = 8883
const VALIDATION_TIMEOUT_MS = 12_000
const TCP_REACHABILITY_TIMEOUT_MS = 3_000

export async function validatePrinterLanConnection(
  input: PrinterConnectionValidationInput,
  options?: {
    mqttConnect?: typeof mqtt.connect
    timeoutMs?: number
    tcpReachabilityProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  }
): Promise<PrinterConnectionValidation> {
  try {
    await connectAndPublishValidationProbe(input, options)
    return {
      ok: true,
      mqttReachable: true,
      developerModeEnabled: true,
      warnings: []
    }
  } catch (error) {
    const classified = await classifyValidationFailure(error, input.host, options)
    return {
      ok: false,
      mqttReachable: classified.mqttReachable,
      developerModeEnabled: classified.developerModeEnabled,
      warnings: classified.warning ? [classified.warning] : []
    }
  }
}

async function connectAndPublishValidationProbe(
  input: PrinterConnectionValidationInput,
  options?: {
    mqttConnect?: typeof mqtt.connect
    timeoutMs?: number
    tcpReachabilityProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  }
): Promise<void> {
  const mqttConnect = options?.mqttConnect ?? mqtt.connect
  const timeoutMs = options?.timeoutMs ?? VALIDATION_TIMEOUT_MS
  const reportTopic = `device/${input.serial}/report`
  const client = mqttConnect(`mqtts://${input.host}:${MQTT_PORT}`, {
    username: 'bblp',
    password: input.accessCode,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    keepalive: 30,
    rejectUnauthorized: false,
    clientId: `bambu-bridge-validate-${process.pid}-${Date.now().toString(36)}`,
    protocolVersion: 4
  })

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      finish(new Error('MQTT validation timed out'))
    }, timeoutMs)

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      client.removeListener('connect', onConnect)
      client.removeListener('error', onError)
      client.removeListener('close', onClose)
      client.removeListener('message', onMessage)
      client.end(true)
      if (error) reject(error)
      else resolve()
    }

    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('MQTT connection closed before validation completed'))
    const onMessage = (topic: string, raw: Buffer) => {
      if (topic !== reportTopic) return

      try {
        JSON.parse(raw.toString('utf8'))
        finish()
      } catch {
        // Ignore malformed packets and keep waiting for a real printer report.
      }
    }
    const onConnect = () => {
      client.subscribe(reportTopic, { qos: 0 }, (subscribeError?: Error | null) => {
        if (subscribeError) {
          finish(subscribeError)
          return
        }

        client.publish(`device/${input.serial}/request`, JSON.stringify({ info: { command: 'get_version' } }), { qos: 1 }, (error) => {
          if (error) finish(error)
        })
      })
    }

    client.once('error', onError)
    client.once('close', onClose)
    client.on('message', onMessage)
    client.once('connect', onConnect)
  })
}

async function classifyValidationFailure(
  error: unknown,
  host: string,
  options?: {
    mqttConnect?: typeof mqtt.connect
    timeoutMs?: number
    tcpReachabilityProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  }
): Promise<{
  mqttReachable: boolean
  developerModeEnabled: boolean | null
  warning: PrinterConnectionWarning | null
}> {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  const looksAuthorizedButRejected = message.includes('not authorized')
    || message.includes('bad username or password')
    || message.includes('auth')

  if (looksAuthorizedButRejected) {
    return buildRejectedLanConnectionResult()
  }

  const tcpReachabilityProbe = options?.tcpReachabilityProbe ?? probeTcpReachability
  const tcpReachable = await tcpReachabilityProbe(host, MQTT_PORT, TCP_REACHABILITY_TIMEOUT_MS)
    .catch(() => false)

  if (tcpReachable) {
    return buildRejectedLanConnectionResult()
  }

  return {
    mqttReachable: false,
    developerModeEnabled: null,
    warning: {
      code: 'localConnectionFailed',
      message: 'The selected bridge could not reach the printer over the local network.'
    }
  }
}

function buildRejectedLanConnectionResult(): {
  mqttReachable: boolean
  developerModeEnabled: boolean | null
  warning: PrinterConnectionWarning | null
} {
  return {
    mqttReachable: true,
    developerModeEnabled: false,
    warning: {
      code: 'developerModeDisabled',
      message: 'The bridge reached the printer, but the printer rejected the LAN connection. Confirm LAN-only mode is enabled and the access code is correct.'
    }
  }
}

function probeTcpReachability(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (reachable: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
    socket.connect(port, host)
  })
}