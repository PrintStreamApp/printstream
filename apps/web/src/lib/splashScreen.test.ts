import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeSplashScreen, resetSplashScreenStateForTests } from './splashScreen.js'

function createFakeElement() {
  const classNames = new Set<string>()
  const dataset: Record<string, string> = {}

  return {
    dataset,
    classList: {
      add: (name: string) => {
        classNames.add(name)
      },
      contains: (name: string) => classNames.has(name)
    },
    style: {
      setProperty: () => {}
    },
    textContent: ''
  }
}

test('completeSplashScreen keeps the splash visible for at least 500ms before hiding it', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })

  const splash = createFakeElement()
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window

  Object.defineProperty(globalThis, 'document', {
    value: {
      getElementById: (id: string) => (id === 'app-splash' ? splash : null)
    },
    configurable: true,
    writable: true
  })
  Object.defineProperty(globalThis, 'window', {
    value: { setTimeout },
    configurable: true,
    writable: true
  })

  resetSplashScreenStateForTests()

  try {
    completeSplashScreen()
    assert.equal(splash.classList.contains('is-complete'), false)
    assert.equal(splash.classList.contains('is-hidden'), false)

    t.mock.timers.tick(499)
    assert.equal(splash.classList.contains('is-complete'), false)

    t.mock.timers.tick(1)
    assert.equal(splash.classList.contains('is-complete'), true)
    assert.equal(splash.classList.contains('is-hidden'), false)

    t.mock.timers.tick(240)
    assert.equal(splash.classList.contains('is-hidden'), true)
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true
    })
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true
    })
    resetSplashScreenStateForTests()
  }
})

test('completeSplashScreen counts from the splash start time instead of from completion time', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 500 })

  const splash = createFakeElement()
  splash.dataset.startedAt = '0'
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window

  Object.defineProperty(globalThis, 'document', {
    value: {
      getElementById: (id: string) => (id === 'app-splash' ? splash : null)
    },
    configurable: true,
    writable: true
  })
  Object.defineProperty(globalThis, 'window', {
    value: { setTimeout },
    configurable: true,
    writable: true
  })

  resetSplashScreenStateForTests()

  try {
    completeSplashScreen()
    t.mock.timers.tick(0)
    assert.equal(splash.classList.contains('is-complete'), true)
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true
    })
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true
    })
    resetSplashScreenStateForTests()
  }
})

test('completeSplashScreen only shows 100% when completion begins', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })

  const splash = createFakeElement()
  const percentNode = createFakeElement()
  const statusNode = createFakeElement()
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window

  Object.defineProperty(globalThis, 'document', {
    value: {
      getElementById: (id: string) => {
        if (id === 'app-splash') return splash
        if (id === 'app-splash-percent') return percentNode
        if (id === 'app-splash-status') return statusNode
        return null
      }
    },
    configurable: true,
    writable: true
  })
  Object.defineProperty(globalThis, 'window', {
    value: { setTimeout },
    configurable: true,
    writable: true
  })

  resetSplashScreenStateForTests()

  try {
    completeSplashScreen()
    assert.equal(percentNode.textContent, '')
    assert.equal(statusNode.textContent, '')

    t.mock.timers.tick(499)
    assert.equal(percentNode.textContent, '')
    assert.equal(statusNode.textContent, '')

    t.mock.timers.tick(1)
    assert.equal(percentNode.textContent, '100%')
    assert.equal(statusNode.textContent, 'App ready')
    assert.equal(splash.classList.contains('is-complete'), true)
  } finally {
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true
    })
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true
    })
    resetSplashScreenStateForTests()
  }
})