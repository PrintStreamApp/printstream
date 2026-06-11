process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Request } from 'express'
import {
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  JOBS_VIEW_PERMISSION,
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTER_STORAGE_DOWNLOAD_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  permissionDefinitions,
  type Permission,
  type PermissionScope
} from '@printstream/shared'
import { assertRequestPermission, PERMISSION_REQUIRED_MESSAGE } from './authorization.js'
import { HttpError } from './http-error.js'
import { PUBLIC_DEMO_GUEST_PERMISSIONS } from './public-demo-policy.js'

const PUBLIC_DEMO_TENANT = { id: 'tenant-demo', slug: 'demo', name: 'Demo' }
const allowedReadPermissions: readonly Permission[] = [
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  PRINTER_STORAGE_VIEW_PERMISSION,
  PRINTER_STORAGE_DOWNLOAD_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  JOBS_VIEW_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  LIBRARY_DOWNLOAD_PERMISSION
]

test('public demo guest permissions are limited to the read-mostly surface', () => {
  assert.deepEqual([...PUBLIC_DEMO_GUEST_PERMISSIONS].sort(), [...allowedReadPermissions].sort())
})

test('public demo guests pass read route permissions and receive 403 for write/admin route permissions', () => {
  const allowed = new Set(PUBLIC_DEMO_GUEST_PERMISSIONS)
  for (const permission of allowedReadPermissions) {
    assert.doesNotThrow(() => assertRequestPermission(makePublicDemoGuestRequest(), permission))
  }

  const deniedPermissions = permissionDefinitions
    .map((definition) => definition.key)
    .filter((permission) => !allowed.has(permission))

  assert.ok(deniedPermissions.length > 0)
  for (const permission of deniedPermissions) {
    assertPublicDemoDenied(permission)
  }

  for (const childScope of [
    'prints.dispatch.printerStorage',
    'printers.manage.ams',
    'printers.manage.settings',
    'printers.manage.storageEdit',
    'printers.manage.storageUpload'
  ] satisfies PermissionScope[]) {
    assertPublicDemoDenied(childScope)
  }
})

function assertPublicDemoDenied(permission: PermissionScope): void {
  assert.throws(
    () => assertRequestPermission(makePublicDemoGuestRequest(), permission),
    (error: unknown) => error instanceof HttpError
      && error.statusCode === 403
      && error.message === PERMISSION_REQUIRED_MESSAGE
  )
}

function makePublicDemoGuestRequest(): Request {
  return {
    auth: {
      authEnabled: false,
      publicDemoGuest: true,
      actor: { type: 'anonymous' },
      permissions: [...PUBLIC_DEMO_GUEST_PERMISSIONS],
      runtimePolicy: { demoMode: true }
    },
    tenant: PUBLIC_DEMO_TENANT
  } as Request
}