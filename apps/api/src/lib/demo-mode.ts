/**
 * Helpers for public demo restrictions.
 *
 * The public demo keeps printer control interactive but blocks printer
 * inventory mutations so the seeded fleet remains stable.
 */
import {
  PRINTERS_MANAGE_PERMISSION,
  type Permission
} from '@printstream/shared'
import type { Request } from 'express'
import { forbidden } from './http-error.js'
import { requestHasPermission } from './auth-context.js'
import { isPublicDemoTenant } from './public-demo-policy.js'

export const DEMO_PRINTER_MUTATION_MESSAGE = 'Printer setup changes are disabled in the public demo.'
export const DEMO_FILE_UPLOAD_MESSAGE = 'File uploads are disabled in the public demo.'
export const DEMO_SETTINGS_MUTATION_MESSAGE = 'Settings changes are disabled in the public demo.'
export const DEMO_AUTH_MUTATION_MESSAGE = 'Auth changes are disabled in the public demo.'
export const DEMO_PRINTER_MUTATION_BYPASS_PERMISSION = PRINTERS_MANAGE_PERMISSION

export function requestHasDemoModeRestrictions(request: Request): boolean {
  return request.auth.runtimePolicy.demoMode || isPublicDemoTenant(request.tenant ?? null)
}

function assertDemoModeAllowsAction(request: Request, input: {
  message: string
  bypassPermission?: Permission
}): void {
  if (!requestHasDemoModeRestrictions(request)) return
  if (input.bypassPermission && requestHasPermission(request, input.bypassPermission)) return
  throw forbidden(input.message)
}

export function assertPrinterMutationsAllowed(request: Request): void {
  assertDemoModeAllowsAction(request, {
    message: DEMO_PRINTER_MUTATION_MESSAGE,
    bypassPermission: DEMO_PRINTER_MUTATION_BYPASS_PERMISSION
  })
}

export function assertFileUploadsAllowed(request: Request, bypassPermission?: Permission): void {
  assertDemoModeAllowsAction(request, {
    message: DEMO_FILE_UPLOAD_MESSAGE,
    bypassPermission
  })
}

export function assertSettingsMutationsAllowed(request: Request): void {
  if (requestHasDemoModeRestrictions(request)) {
    throw forbidden(DEMO_SETTINGS_MUTATION_MESSAGE)
  }
}

export function assertAuthMutationsAllowed(request: Request): void {
  if (requestHasDemoModeRestrictions(request)) {
    throw forbidden(DEMO_AUTH_MUTATION_MESSAGE)
  }
}

export function assertDemoModeAllowsWithPermission(request: Request, input: {
  message: string
  bypassPermission: Permission
}): void {
  if (requestHasDemoModeRestrictions(request) && !requestHasPermission(request, input.bypassPermission)) {
    throw forbidden(input.message)
  }
}