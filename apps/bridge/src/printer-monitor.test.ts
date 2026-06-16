import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
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