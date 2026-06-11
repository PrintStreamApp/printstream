/**
 * One-shot MQTT request publisher for Bambu printers.
 *
 * Used by the bridge runtime to deliver command payloads locally without
 * keeping the API process on the printer LAN.
 */
import mqtt from 'mqtt'
import type { Printer } from '@printstream/shared'

const MQTT_PORT = 8883

export async function publishPrinterCommand(printer: Printer, payload: Record<string, unknown>): Promise<void> {
  const url = `mqtts://${printer.host}:${MQTT_PORT}`
  const client = mqtt.connect(url, {
    username: 'bblp',
    password: printer.accessCode,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    keepalive: 30,
    rejectUnauthorized: false,
    clientId: `bambu-bridge-${printer.id}-${process.pid}-${Date.now().toString(36)}`,
    protocolVersion: 4
  })

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      client.removeListener('connect', onConnect)
      client.removeListener('error', onError)
      client.removeListener('close', onClose)
      client.end(true)
      if (error) reject(error)
      else resolve()
    }

    const onError = (error: Error) => finish(error)
    const onClose = () => finish(new Error('MQTT connection closed before command publish'))
    const onConnect = () => {
      const topic = `device/${printer.serial}/request`
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) finish(error)
        else finish()
      })
    }

    client.once('error', onError)
    client.once('close', onClose)
    client.once('connect', onConnect)
  })
}