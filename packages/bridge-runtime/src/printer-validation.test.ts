process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { validatePrinterLanConnection } from './printer-validation.js'

class FakeMqttClient extends EventEmitter {
  end(): void {}

  subscribe(
    _topic: string,
    _options: { qos: number },
    callback: (error?: Error | null) => void
  ): void {
    callback(null)
  }

  publish(_topic: string, _message: string, _options: { qos: number }, callback: (error?: Error) => void): void {
    callback()
  }
}

test('validatePrinterLanConnection returns a local connection failure when the MQTT probe stalls', async () => {
  const result = await validatePrinterLanConnection({
    host: '192.0.2.10',
    serial: '01P00A000000000',
    accessCode: 'access-code'
  }, {
    mqttConnect: () => new FakeMqttClient() as never,
    timeoutMs: 20,
    tcpReachabilityProbe: async () => false
  })

  assert.deepEqual(result, {
    ok: false,
    mqttReachable: false,
    developerModeEnabled: null,
    warnings: [{
      code: 'localConnectionFailed',
      message: 'The selected bridge could not reach the printer over the local network.'
    }]
  })
})

test('validatePrinterLanConnection reports rejected LAN auth when TCP is reachable but MQTT validation closes early', async () => {
  const result = await validatePrinterLanConnection({
    host: '192.0.2.11',
    serial: '01P00A000000001',
    accessCode: 'wrong-code'
  }, {
    mqttConnect: () => {
      const client = new FakeMqttClient()
      queueMicrotask(() => {
        client.emit('close')
      })
      return client as never
    },
    timeoutMs: 50,
    tcpReachabilityProbe: async () => true
  })

  assert.deepEqual(result, {
    ok: false,
    mqttReachable: true,
    developerModeEnabled: false,
    warnings: [{
      code: 'developerModeDisabled',
      message: 'The bridge reached the printer, but the printer rejected the LAN connection. Confirm LAN-only mode is enabled and the access code is correct.'
    }]
  })
})

test('validatePrinterLanConnection succeeds when the printer replies with get_version before a publish callback', async () => {
  const result = await validatePrinterLanConnection({
    host: '192.0.2.12',
    serial: '01P00A000000002',
    accessCode: 'access-code'
  }, {
    mqttConnect: () => {
      const client = new ReportBeforePubackClient()
      queueMicrotask(() => {
        client.emit('connect')
      })
      return client as never
    },
    timeoutMs: 50
  })

  assert.deepEqual(result, {
    ok: true,
    mqttReachable: true,
    developerModeEnabled: true,
    warnings: []
  })
})

test('validatePrinterLanConnection succeeds when the printer publishes status without a get_version reply', async () => {
  const result = await validatePrinterLanConnection({
    host: '192.0.2.13',
    serial: '09400A000000003',
    accessCode: 'access-code'
  }, {
    mqttConnect: () => {
      const client = new PushStatusClient()
      queueMicrotask(() => {
        client.emit('connect')
      })
      return client as never
    },
    timeoutMs: 50
  })

  assert.deepEqual(result, {
    ok: true,
    mqttReachable: true,
    developerModeEnabled: true,
    warnings: []
  })
})

class ReportBeforePubackClient extends FakeMqttClient {
  override publish(topic: string, _message: string, _options: { qos: number }, _callback: (error?: Error) => void): void {
    queueMicrotask(() => {
      this.emit('message', topic.replace('/request', '/report'), Buffer.from(JSON.stringify({
        info: {
          command: 'get_version',
          result: 'success'
        }
      }), 'utf8'))
    })
  }
}

class PushStatusClient extends FakeMqttClient {
  override publish(topic: string, _message: string, _options: { qos: number }, callback: (error?: Error) => void): void {
    callback()
    queueMicrotask(() => {
      this.emit('message', topic.replace('/request', '/report'), Buffer.from(JSON.stringify({
        print: {
          command: 'push_status',
          sequence_id: '2021'
        }
      }), 'utf8'))
    })
  }
}
