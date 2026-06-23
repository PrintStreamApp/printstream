process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Request } from 'express'
import { ANONYMOUS_FAVORITE_OWNER_KEY, resolveFavoriteOwnerKey } from './library-favorites.js'

function requestWithActor(actor: unknown): Request {
  return { auth: { actor } } as unknown as Request
}

test('resolveFavoriteOwnerKey returns the user id for an authenticated user', () => {
  assert.equal(resolveFavoriteOwnerKey(requestWithActor({ type: 'user', userId: 'user-1' })), 'user-1')
})

test('resolveFavoriteOwnerKey namespaces service accounts so they do not collide with users', () => {
  assert.equal(
    resolveFavoriteOwnerKey(requestWithActor({ type: 'service-account', serviceAccountId: 'svc-1' })),
    'svc:svc-1'
  )
})

test('resolveFavoriteOwnerKey falls back to the anonymous sentinel for no-auth installs', () => {
  assert.equal(resolveFavoriteOwnerKey(requestWithActor({ type: 'anonymous' })), ANONYMOUS_FAVORITE_OWNER_KEY)
  // Missing auth context entirely (defensive) also resolves to the sentinel.
  assert.equal(resolveFavoriteOwnerKey({} as unknown as Request), ANONYMOUS_FAVORITE_OWNER_KEY)
})
