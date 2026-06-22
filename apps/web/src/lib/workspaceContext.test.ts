import assert from 'node:assert/strict'
import test from 'node:test'
import { readWorkspaceContextHeader, readWorkspaceContextHint } from './workspaceContext'

test('readWorkspaceContextHint uses tenant slugs from workspace routes', () => {
  withBrowserPath('/workspaces/Alpha/printers', () => {
    assert.deepEqual(readWorkspaceContextHint(), { type: 'tenant', slug: 'alpha' })
    assert.equal(readWorkspaceContextHeader(), 'alpha')
  })
})

test('readWorkspaceContextHint uses platform only from platform routes', () => {
  withBrowserPath('/platform/settings', () => {
    assert.deepEqual(readWorkspaceContextHint(), { type: 'platform' })
    assert.equal(readWorkspaceContextHeader(), 'platform')
  })
})

test('readWorkspaceContextHeader sends a neutral hint outside explicit workspace routes', () => {
  withBrowserPath('/workspaces', () => {
    assert.equal(readWorkspaceContextHint(), null)
    assert.equal(readWorkspaceContextHeader(), 'none')
  })

  withBrowserPath('/auth', () => {
    assert.equal(readWorkspaceContextHint(), null)
    assert.equal(readWorkspaceContextHeader(), 'none')
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
