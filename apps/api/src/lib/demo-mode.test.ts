import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LIBRARY_UPLOAD_PERMISSION,
  type Permission
} from '@printstream/shared'
import {
  assertDemoModeAllowsWithPermission,
  assertFileUploadsAllowed,
  assertPrinterMutationsAllowed,
  DEMO_FILE_UPLOAD_MESSAGE,
  DEMO_PRINTER_MUTATION_BYPASS_PERMISSION,
  DEMO_PRINTER_MUTATION_MESSAGE
} from './demo-mode.js'
import { HttpError } from './http-error.js'
import type { Request } from 'express'

function makeRequest(input: { demoMode: boolean; permissions?: Permission[] }): Request {
  return {
    auth: {
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: input.permissions ?? [],
      runtimePolicy: { demoMode: input.demoMode }
    }
  } as Request
}

test('assertPrinterMutationsAllowed permits printer changes outside demo mode', () => {
  assert.doesNotThrow(() => {
    assertPrinterMutationsAllowed(makeRequest({ demoMode: false }))
  })
})

test('assertPrinterMutationsAllowed blocks printer changes in demo mode with a 403', () => {
  assert.throws(
    () => {
      assertPrinterMutationsAllowed(makeRequest({ demoMode: true }))
    },
    (error: unknown) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.statusCode, 403)
      assert.equal(error.message, DEMO_PRINTER_MUTATION_MESSAGE)
      return true
    }
  )
})

test('assertFileUploadsAllowed permits uploads outside demo mode', () => {
  assert.doesNotThrow(() => {
    assertFileUploadsAllowed(makeRequest({ demoMode: false }), LIBRARY_UPLOAD_PERMISSION)
  })
})

test('assertFileUploadsAllowed blocks uploads in demo mode with a 403', () => {
  assert.throws(
    () => {
      assertFileUploadsAllowed(makeRequest({ demoMode: true }), LIBRARY_UPLOAD_PERMISSION)
    },
    (error: unknown) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.statusCode, 403)
      assert.equal(error.message, DEMO_FILE_UPLOAD_MESSAGE)
      return true
    }
  )
})

test('assertPrinterMutationsAllowed permits explicit maintenance actors in demo mode', () => {
  assert.doesNotThrow(() => {
    assertPrinterMutationsAllowed(makeRequest({
      demoMode: true,
      permissions: [DEMO_PRINTER_MUTATION_BYPASS_PERMISSION]
    }))
  })
})

test('assertDemoModeAllowsWithPermission blocks when the named bypass permission is absent', () => {
  assert.throws(
    () => {
      assertDemoModeAllowsWithPermission(makeRequest({ demoMode: true }), {
        message: DEMO_FILE_UPLOAD_MESSAGE,
        bypassPermission: LIBRARY_UPLOAD_PERMISSION
      })
    },
    (error: unknown) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.statusCode, 403)
      assert.equal(error.message, DEMO_FILE_UPLOAD_MESSAGE)
      return true
    }
  )
})

test('assertDemoModeAllowsWithPermission permits when the named bypass permission is present', () => {
  assert.doesNotThrow(() => {
    assertDemoModeAllowsWithPermission(makeRequest({ demoMode: true, permissions: [LIBRARY_UPLOAD_PERMISSION] }), {
      message: DEMO_FILE_UPLOAD_MESSAGE,
      bypassPermission: LIBRARY_UPLOAD_PERMISSION
    })
  })
})