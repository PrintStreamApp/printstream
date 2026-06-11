/**
 * Shared request-derived helpers for routes and plugins.
 */
import type { Request } from 'express'
import { badRequest } from './http-error.js'

export function requireRouteParam(value: string | string[] | undefined, name: string): string {
  const resolved = Array.isArray(value) ? value[0] : value
  if (typeof resolved === 'string' && resolved.length > 0) {
    return resolved
  }
  throw badRequest(`Missing route parameter: ${name}`)
}

export function requireRequestTenantId(request: Request): string {
  if (request.tenant?.id) {
    return request.tenant.id
  }
  throw badRequest('Tenant context is required')
}

export function readRequestLocale(request: Request): string | null {
  const header = request.headers['accept-language']
  const value = Array.isArray(header) ? header[0] : header
  const locale = value?.split(',')[0]?.trim()
  return locale || null
}

export function readRequestTimeZone(request: Request): string | null {
  const header = request.headers['x-printstream-time-zone']
  const value = Array.isArray(header) ? header[0] : header
  const timeZone = value?.trim()
  return timeZone || null
}