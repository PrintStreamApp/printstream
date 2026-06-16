/**
 * Request-level authorization helpers.
 *
 * These guards intentionally become active only once auth is enabled for the
 * request. That lets the codebase start annotating privileged routes now
 * without breaking today's unauthenticated installs.
 */
import type { NextFunction, Request, Response } from 'express'
import { AUTH_PROVIDERS_MANAGE_PERMISSION, resolvePermissionScope, type PermissionScope } from '@printstream/shared'
import { noteRequestAuditPermission } from './audit-logs.js'
import { authUsesExplicitPermissions, requestHasPermission } from './auth-context.js'
import { forbidden, unauthorized } from './http-error.js'

export const AUTHENTICATION_REQUIRED_MESSAGE = 'Authentication required.'
export const PERMISSION_REQUIRED_MESSAGE = 'You do not have permission to perform this action.'

export function requestIsAuthenticated(request: Request): boolean {
  return request.auth.actor.type !== 'anonymous'
}

function shouldBypassPermissionEnforcement(request: Request, permission: PermissionScope): boolean {
  if (authUsesExplicitPermissions(request.auth)) {
    return false
  }

  if (request.tenant != null) {
    return true
  }

  return request.auth.actor.type === 'anonymous'
    && resolvePermissionScope(permission) === AUTH_PROVIDERS_MANAGE_PERMISSION
}

function shouldEnforcePermission(request: Request, permission: PermissionScope): boolean {
  return !shouldBypassPermissionEnforcement(request, permission)
}

export function assertRequestPermission(request: Request, permission: PermissionScope, input: {
  unauthenticatedMessage?: string
  forbiddenMessage?: string
} = {}): void {
  noteRequestAuditPermission(request, permission)
  if (!shouldEnforcePermission(request, permission)) return
  if (!requestIsAuthenticated(request) && !request.auth.publicDemoGuest) {
    throw unauthorized(input.unauthenticatedMessage ?? AUTHENTICATION_REQUIRED_MESSAGE)
  }
  if (!requestHasPermission(request, permission)) {
    throw forbidden(input.forbiddenMessage ?? PERMISSION_REQUIRED_MESSAGE)
  }
}

export function requireRequestPermission(permission: PermissionScope, input: {
  unauthenticatedMessage?: string
  forbiddenMessage?: string
} = {}) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    try {
      assertRequestPermission(request, permission, input)
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Middleware that requires an authenticated human user with a specific permission.
 */
export function requireAuthenticatedRequestPermission(permission: PermissionScope) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    try {
      noteRequestAuditPermission(request, permission)
      if (request.auth.actor.type !== 'user') {
        throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
      }
      if (shouldEnforcePermission(request, permission) && !requestHasPermission(request, permission)) {
        throw forbidden(PERMISSION_REQUIRED_MESSAGE)
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Middleware that requires the request actor to be an authenticated user.
 */
export function requireAuthenticatedCurrentUser() {
  return (request: Request, _response: Response, next: NextFunction): void => {
    try {
      if (request.auth.actor.type !== 'user') {
        throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}