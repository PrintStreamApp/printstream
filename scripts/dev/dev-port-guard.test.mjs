import assert from 'node:assert/strict'
import test from 'node:test'
import { assertHostDevPortsAvailable } from './dev-port-guard.mjs'

const hostMode = {
  ports: { web: 22070 },
  project: { ports: ['web'] },
  url: 'http://printstream.localhost'
}

test('does nothing when Devkit host mode is disabled', async () => {
  let probes = 0
  await assertHostDevPortsAvailable(null, { isPortAvailable: async () => { probes += 1; return false } })
  assert.equal(probes, 0)
})

test('accepts an unused published port', async () => {
  const probed = []
  await assertHostDevPortsAvailable(hostMode, {
    isPortAvailable: async (port) => { probed.push(port); return true }
  })
  assert.deepEqual(probed, [22070])
})

test('rejects a duplicate stack before services can walk to fallback ports', async () => {
  await assert.rejects(
    () => assertHostDevPortsAvailable(hostMode, {
      isPortAvailable: async (port) => port !== 22070
    }),
    (error) => {
      assert.match(error.message, /web 22070/)
      assert.match(error.message, /existing stack at http:\/\/printstream\.localhost/)
      return true
    }
  )
})
