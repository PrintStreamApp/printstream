import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock, test } from 'node:test'
import type { connect as mqttConnect } from 'mqtt'
import type { Printer } from '@printstream/shared'
import { BridgePrinterMonitor } from './printer-monitor.js'

class FakeMqttClient extends EventEmitter {
  connected = false
  subscribeCalls: Array<{ topic: string; qos: number }> = []
  publishCalls: Array<{ topic: string; payload: string; qos: number }> = []

  subscribe(topic: string, options: { qos: number }, callback: (error: Error | null, granted?: unknown) => void): void {
    this.subscribeCalls.push({ topic, qos: options.qos })
    callback(null)
  }

  publish(topic: string, payload: string, options: { qos: number }): void {
    this.publishCalls.push({ topic, payload, qos: options.qos })
  }

  end(): void {}
}

function makePrinter(): Printer {
  return {
    id: 'printer-1',
    name: 'Test Printer',
    host: '192.168.1.52',
    serial: 'SERIAL-1',
    accessCode: '12345678',
    model: 'P1S',
    currentPlateType: null,
    currentNozzleDiameters: []
  }
}

test('BridgePrinterMonitor marks a printer offline when MQTT connect errors before reconnect', () => {
  const client = new FakeMqttClient()
  const messages: unknown[] = []
  const monitor = new BridgePrinterMonitor(
    (message) => {
      messages.push(message)
    },
    (() => client as never) as typeof mqttConnect
  )

  monitor.updatePrinters([makePrinter()])

  client.emit('error', new Error('connect ENETUNREACH'))
  client.emit('error', new Error('connect ENETUNREACH'))

  assert.deepEqual(messages, [
    { type: 'bridge.printer.offline', printerId: 'printer-1' }
  ])
})

test('BridgePrinterMonitor resets offline suppression after reconnecting', () => {
  const client = new FakeMqttClient()
  const messages: unknown[] = []
  const monitor = new BridgePrinterMonitor(
    (message) => {
      messages.push(message)
    },
    (() => client as never) as typeof mqttConnect
  )

  monitor.updatePrinters([makePrinter()])

  client.emit('error', new Error('connect ENETUNREACH'))
  client.connected = true
  client.emit('connect')
  client.connected = false
  client.emit('error', new Error('Keepalive timeout'))

  assert.deepEqual(messages, [
    { type: 'bridge.printer.offline', printerId: 'printer-1' },
    { type: 'bridge.printer.offline', printerId: 'printer-1' }
  ])
  assert.equal(client.subscribeCalls.length, 1)
  assert.equal(client.publishCalls.length, 2)
})

test('BridgePrinterMonitor recreates the client with a fresh clientId after a stalled report stream', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  try {
    const clientIds: string[] = []
    const clients: FakeMqttClient[] = []
    const monitor = new BridgePrinterMonitor(
      () => {},
      ((_url: string, options: { clientId: string }) => {
        clientIds.push(options.clientId)
        const client = new FakeMqttClient()
        clients.push(client)
        return client as never
      }) as typeof mqttConnect
    )

    monitor.updatePrinters([makePrinter()])
    // The first client connects but then its report stream goes silent.
    clients[0].connected = true
    clients[0].emit('connect')

    // Advance past the stale threshold so the watchdog tears the wedged client
    // down and rebuilds it.
    mock.timers.tick(120_000)

    assert.equal(clientIds.length, 2, 'expected the client to be recreated once')
    assert.notEqual(clientIds[0], clientIds[1], 'recreated client should use a fresh clientId')
  } finally {
    mock.timers.reset()
  }
})

test('BridgePrinterMonitor keeps a fresh report stream alive without recreating the client', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  try {
    let clientCount = 0
    const client = new FakeMqttClient()
    const monitor = new BridgePrinterMonitor(
      () => {},
      (() => {
        clientCount += 1
        return client as never
      }) as typeof mqttConnect
    )

    monitor.updatePrinters([makePrinter()])
    client.connected = true
    client.emit('connect')

    // A report arrives within every watchdog window, so the connection is healthy.
    for (let elapsed = 0; elapsed < 200_000; elapsed += 20_000) {
      client.emit('message', 'device/SERIAL-1/report', Buffer.from('{"print":{}}'))
      mock.timers.tick(20_000)
    }

    assert.equal(clientCount, 1, 'a healthy connection should never be recreated')
  } finally {
    mock.timers.reset()
  }
})

test('BridgePrinterMonitor.isConnected reflects the live MQTT connection state', () => {
  const client = new FakeMqttClient()
  const monitor = new BridgePrinterMonitor(() => {}, (() => client as never) as typeof mqttConnect)

  monitor.updatePrinters([makePrinter()])
  assert.equal(monitor.isConnected('printer-1'), false, 'not connected before the client opens')

  client.connected = true
  client.emit('connect')
  assert.equal(monitor.isConnected('printer-1'), true, 'connected after the client opens')

  client.connected = false
  assert.equal(monitor.isConnected('printer-1'), false, 'disconnected once the client drops')
  assert.equal(monitor.isConnected('unknown-printer'), false, 'unknown printers are never connected')
})

test('BridgePrinterMonitor re-requests pushall on an interval while connected', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    const client = new FakeMqttClient()
    const monitor = new BridgePrinterMonitor(() => {}, (() => client as never) as typeof mqttConnect)

    monitor.updatePrinters([makePrinter()])
    client.connected = true
    client.emit('connect')

    const initialPublishCount = client.publishCalls.length
    mock.timers.tick(31_000)

    const pushallPublishes = client.publishCalls.filter((call) => call.payload.includes('pushall')).length
    assert.ok(pushallPublishes >= 2, 'expected the connect pushall plus at least one interval pushall')
    assert.ok(client.publishCalls.length > initialPublishCount, 'expected the pushall interval to publish again')
  } finally {
    mock.timers.reset()
  }
})