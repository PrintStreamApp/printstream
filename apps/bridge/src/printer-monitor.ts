import mqtt, { type MqttClient } from 'mqtt'
import type { Printer } from '@printstream/shared'
import { publishPrinterCommand } from '@printstream/bridge-runtime'

interface MonitoredPrinter {
  printer: Printer
  client: MqttClient
  offlineAnnounced: boolean
}

const MQTT_PORT = 8883

export class BridgePrinterMonitor {
  private readonly printers = new Map<string, MonitoredPrinter>()

  constructor(
    private readonly sendMessage: (message: unknown) => void,
    private readonly connectClient: typeof mqtt.connect = mqtt.connect
  ) {}

  updatePrinters(printers: readonly Printer[]): void {
    const nextIds = new Set(printers.map((printer) => printer.id))

    for (const printerId of this.printers.keys()) {
      if (!nextIds.has(printerId)) {
        this.removePrinter(printerId, true)
      }
    }

    for (const printer of printers) {
      this.upsertPrinter(printer)
    }
  }

  async sendCommand(printer: Printer, payload: Record<string, unknown>): Promise<void> {
    const existing = this.printers.get(printer.id)
    if (existing?.client.connected) {
      existing.client.publish(`device/${printer.serial}/request`, JSON.stringify(payload), { qos: 1 })
      return
    }

    await publishPrinterCommand(printer, payload)
  }

  stopAll(): void {
    for (const printerId of this.printers.keys()) {
      this.removePrinter(printerId, false)
    }
  }

  private upsertPrinter(printer: Printer): void {
    const existing = this.printers.get(printer.id)
    if (existing) {
      if (samePrinterConnection(existing.printer, printer)) {
        existing.printer = printer
        return
      }
      this.removePrinter(printer.id, false)
    }

    const client = this.connectClient(`mqtts://${printer.host}:${MQTT_PORT}`, {
      username: 'bblp',
      password: printer.accessCode,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      keepalive: 30,
      rejectUnauthorized: false,
      clientId: `bambu-bridge-${printer.id}-${process.pid}-${Date.now().toString(36)}`,
      protocolVersion: 4
    })

    const entry: MonitoredPrinter = { printer, client, offlineAnnounced: false }
    this.printers.set(printer.id, entry)

    client.on('connect', () => {
      entry.offlineAnnounced = false
      client.subscribe(`device/${printer.serial}/report`, { qos: 0 }, (error) => {
        if (error) {
          console.error(`[bridge:printer:${printer.name}] subscribe failed`, error.message)
          this.announceOffline(entry)
          return
        }
        client.publish(`device/${printer.serial}/request`, JSON.stringify({ pushing: { command: 'pushall' } }), { qos: 1 })
        client.publish(`device/${printer.serial}/request`, JSON.stringify({ info: { command: 'get_version' } }), { qos: 1 })
      })
    })

    client.on('message', (_topic, raw) => {
      entry.offlineAnnounced = false
      let report: unknown
      try {
        report = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      this.sendMessage({
        type: 'bridge.printer.report',
        printerId: printer.id,
        report
      })
    })

    client.on('reconnect', () => {
      this.announceOffline(entry)
    })

    client.on('close', () => {
      this.announceOffline(entry)
    })

    client.on('error', (error) => {
      console.error(`[bridge:printer:${printer.name}] mqtt error`, error.message)
      if (!client.connected) {
        this.announceOffline(entry)
      }
    })
  }

  private announceOffline(entry: MonitoredPrinter): void {
    if (entry.offlineAnnounced) return
    entry.offlineAnnounced = true
    this.sendMessage({ type: 'bridge.printer.offline', printerId: entry.printer.id })
  }

  private removePrinter(printerId: string, announceRemoval: boolean): void {
    const entry = this.printers.get(printerId)
    if (!entry) return
    this.printers.delete(printerId)
    entry.client.end(true)
    if (announceRemoval) {
      this.sendMessage({
        type: 'bridge.printer.removed',
        printerId
      })
    }
  }
}

function samePrinterConnection(left: Printer, right: Printer): boolean {
  return left.host === right.host && left.serial === right.serial && left.accessCode === right.accessCode
}