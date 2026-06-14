import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import type { DiscoveredPrinter, PrinterModel } from '@printstream/shared'

const SSDP_MULTICAST_ADDR = '239.255.255.250'
const DEFAULT_PORT = 2021
const ENTRY_TTL_MS = 5 * 60_000
const PRUNE_INTERVAL_MS = 60_000

/** Map Bambu device-model codes to the short labels the UI uses. */
const MODEL_CODE_TO_LABEL: Record<string, PrinterModel> = {
  'BL-P001': 'X1C',
  'BL-P002': 'X1C',
  'BL-P003': 'X1E',
  N6: 'X2D',
  'C11': 'P1P',
  'C12': 'P1S',
  P2S: 'P2S',
  'N1': 'A1mini',
  'N2': 'A1',
  N9: 'A2L',
  'BL-D001': 'H2D',
  O1D: 'H2D',
  H2DPRO: 'H2DPRO',
  O1C: 'H2C',
  O1C2: 'H2C',
  H2S: 'H2S'
}

interface DiscoveryEntry {
  serial: string
  host: string
  modelCode: string | null
  model: PrinterModel
  name: string | null
  firmware: string | null
  lastSeen: number
}

interface PrinterDiscoveryDeps {
  now: () => number
}

const defaultDeps: PrinterDiscoveryDeps = {
  now: () => Date.now()
}

export class PrinterDiscovery {
  private socket: dgram.Socket | null = null
  private readonly entries = new Map<string, DiscoveryEntry>()
  private pruneTimer: NodeJS.Timeout | null = null
  private started = false

  constructor(
    private readonly onSnapshot: (printers: DiscoveredPrinter[]) => void,
    private readonly deps: PrinterDiscoveryDeps = defaultDeps
  ) {}

  start(port = DEFAULT_PORT): void {
    if (this.started) return
    this.started = true

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    socket.on('error', (error) => {
      console.warn('[bridge:discovery] socket error', error.message)
    })

    socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg.toString('utf8'), rinfo.address)
    })

    socket.on('listening', () => {
      try {
        socket.addMembership(SSDP_MULTICAST_ADDR)
      } catch {
        // Best-effort: some hosts only allow direct replies on the port.
      }
      for (const ifaces of Object.values(networkInterfaces())) {
        if (!ifaces) continue
        for (const iface of ifaces) {
          if (iface.family !== 'IPv4' || iface.internal) continue
          try {
            socket.addMembership(SSDP_MULTICAST_ADDR, iface.address)
          } catch {
            // Ignore interfaces that reject multicast membership.
          }
        }
      }
    })

    try {
      socket.bind({ port, exclusive: false })
      this.socket = socket
    } catch (error) {
      console.warn('[bridge:discovery] failed to bind UDP socket', (error as Error).message)
      this.started = false
      return
    }

    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS)
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref()
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    if (this.socket) {
      try { this.socket.close() } catch { /* already closed */ }
      this.socket = null
    }
    this.entries.clear()
    this.started = false
  }

  list(): DiscoveredPrinter[] {
    return Array.from(this.entries.values())
      .sort((a, b) => (a.name ?? a.serial).localeCompare(b.name ?? b.serial))
      .map((entry) => ({
        serial: entry.serial,
        host: entry.host,
        modelCode: entry.modelCode,
        model: entry.model,
        name: entry.name,
        firmware: entry.firmware,
        lastSeenAt: new Date(entry.lastSeen).toISOString()
      }))
  }

  private handleMessage(payload: string, sender: string): void {
    if (!payload.includes('bambu')) return
    const headers = parseSsdpHeaders(payload)
    const serial = headers['usn'] || headers['dev.serialno.bambu.com'] || null
    if (!serial) return
    const modelCode = headers['devmodel.bambu.com'] || null
    const name = headers['devname.bambu.com'] || null
    const firmware = headers['devversion.bambu.com'] || null
    const host = headers['location'] || sender

    this.entries.set(serial, {
      serial,
      host,
      modelCode,
      model: normalizeDiscoveredModel(modelCode),
      name,
      firmware,
      lastSeen: this.deps.now()
    })
    this.onSnapshot(this.list())
  }

  private prune(): void {
    const cutoff = this.deps.now() - ENTRY_TTL_MS
    let dropped = false
    for (const [serial, entry] of this.entries) {
      if (entry.lastSeen < cutoff) {
        this.entries.delete(serial)
        dropped = true
      }
    }
    if (dropped) this.onSnapshot(this.list())
  }
}

function normalizeDiscoveredModel(value: string | null): PrinterModel {
  if (!value) return 'unknown'
  const canonical = value.trim().toUpperCase()
  if (!canonical) return 'unknown'

  return MODEL_CODE_TO_LABEL[canonical]
    ?? MODEL_CODE_TO_LABEL[canonical.replace(/\s+/g, '')]
    ?? ({
      'BAMBU LAB P2S': 'P2S',
      'BAMBU LAB H2D PRO': 'H2DPRO',
      'BAMBU LAB H2S': 'H2S',
      'H2D PRO': 'H2DPRO'
    } satisfies Partial<Record<string, PrinterModel>>)[canonical]
    ?? 'unknown'
}

/** Parse SSDP-style `Header: value` lines into a lower-cased map. */
function parseSsdpHeaders(payload: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of payload.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key && value) out[key] = value
  }
  return out
}