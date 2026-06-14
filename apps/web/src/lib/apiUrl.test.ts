import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApiUrl, buildApiUrlWithContext } from './apiUrl.js'

test('buildApiUrl appends tenant context to relative API URLs', () => {
  withBrowserPath('/workspaces/alpha/printers', () => {
    assert.equal(buildApiUrl('/api/camera/printer-1/snapshot?t=12'), '/api/camera/printer-1/snapshot?t=12&tenant=alpha')
  })
})

test('buildApiUrl appends tenant context to absolute API URLs', () => {
  assert.equal(
    buildApiUrlWithContext('/api/camera/printer-1/snapshot?t=12', 'http://localhost:4000', 'alpha'),
    'http://localhost:4000/api/camera/printer-1/snapshot?t=12&tenant=alpha'
  )
})

test('buildApiUrl appends explicit no-workspace context outside workspace routes', () => {
  withBrowserPath('/auth', () => {
    assert.equal(buildApiUrl('/api/camera/printer-1/snapshot'), '/api/camera/printer-1/snapshot?tenant=none')
  })
})

function withBrowserPath(pathname: string, callback: () => void): void {
  const previousWindow = globalThis.window
  const storage = new Map<string, string>()

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { pathname },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    }
  })

  try {
    callback()
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow
    })
  }
}