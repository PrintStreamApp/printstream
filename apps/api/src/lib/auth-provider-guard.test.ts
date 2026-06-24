import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { AuthProviderCapabilities } from '@printstream/shared'
import { authProviderRegistry } from './auth-registry.js'
import { HttpError } from './http-error.js'
import { assertAuthProviderCanChangeState, restoreSupportAccessWhenWorkspaceAuthDisabled } from './auth-provider-guard.js'

const capabilities: AuthProviderCapabilities = {
  signIn: true,
  setup: true,
  accountSecurity: false,
  adminUserProvisioning: false,
  adminUserCredentials: false,
  recentVerificationMethods: []
}

afterEach(() => {
  authProviderRegistry.clear()
})

test('last enabled auth provider cannot be disabled', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities
  })

  await assert.rejects(
    async () => await assertAuthProviderCanChangeState({
      providerId: 'auth-local',
      currentEnabled: true,
      nextEnabled: false
    }),
    (error: unknown) => {
      assert.equal(error instanceof HttpError, true)
      assert.equal((error as HttpError).statusCode, 409)
      assert.equal((error as HttpError).message, 'Enable another auth provider before disabling the last sign-in method in this workspace.')
      return true
    }
  )
})

test('auth provider can be disabled once another provider is enabled', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities
  })
  authProviderRegistry.register({
    id: 'auth-oauth',
    label: 'Single Sign-On',
    enabled: true,
    methods: ['oauth'],
    setupRequired: false,
    capabilities
  })

  await assert.doesNotReject(async () => await assertAuthProviderCanChangeState({
    providerId: 'auth-local',
    currentEnabled: true,
    nextEnabled: false
  }))
})

test('last enabled auth provider can be disabled while setup is still incomplete', async () => {
  authProviderRegistry.register({
    id: 'auth-oauth',
    label: 'Single Sign-On',
    enabled: true,
    methods: ['oauth'],
    setupRequired: true,
    capabilities
  })

  await assert.doesNotReject(async () => await assertAuthProviderCanChangeState({
    providerId: 'auth-oauth',
    currentEnabled: true,
    nextEnabled: false
  }))
})

test('workspace admins cannot disable the last enabled auth provider', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities
  })

  await assert.rejects(
    async () => await assertAuthProviderCanChangeState({
      providerId: 'auth-local',
      currentEnabled: true,
      nextEnabled: false,
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
      isPlatformUser: false
    }),
    (error: unknown) => {
      assert.equal(error instanceof HttpError, true)
      assert.equal((error as HttpError).statusCode, 409)
      assert.equal((error as HttpError).message, 'Only a support user can disable the last sign-in method in this workspace.')
      return true
    }
  )
})

test('self-hosted workspace admins can disable the last enabled auth provider', async () => {
  authProviderRegistry.register({
    id: 'auth-password',
    label: 'Password',
    enabled: true,
    methods: ['password'],
    setupRequired: false,
    capabilities
  })

  await assert.doesNotReject(async () => await assertAuthProviderCanChangeState({
    providerId: 'auth-password',
    currentEnabled: true,
    nextEnabled: false,
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    isPlatformUser: false,
    selfHosted: true
  }))
})

test('platform users can disable the last enabled auth provider in a workspace', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities
  })

  await assert.doesNotReject(async () => await assertAuthProviderCanChangeState({
    providerId: 'auth-local',
    currentEnabled: true,
    nextEnabled: false,
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    isPlatformUser: true
  }))
})

test('tenant auth providers cannot be enabled until platform auth is enabled', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: false,
    methods: ['passkey'],
    setupRequired: false,
    capabilities
  })

  await assert.rejects(
    async () => await assertAuthProviderCanChangeState({
      providerId: 'auth-local',
      currentEnabled: false,
      nextEnabled: true,
      tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }),
    (error: unknown) => {
      assert.equal(error instanceof HttpError, true)
      assert.equal((error as HttpError).statusCode, 409)
      assert.equal((error as HttpError).message, 'Enable platform authentication before configuring tenant sign-in.')
      return true
    }
  )
})

test('self-hosted workspaces can enable tenant auth without platform auth', async () => {
  authProviderRegistry.register({
    id: 'auth-password',
    label: 'Password',
    enabled: false,
    methods: ['password'],
    setupRequired: true,
    capabilities
  })

  await assert.doesNotReject(async () => await assertAuthProviderCanChangeState({
    providerId: 'auth-password',
    currentEnabled: false,
    nextEnabled: true,
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    selfHosted: true
  }))
})

test('tenant auth providers can be enabled once platform auth is enabled', async () => {
  authProviderRegistry.register(() => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities
  }))

  await assert.doesNotReject(async () => await assertAuthProviderCanChangeState({
    providerId: 'auth-oauth',
    currentEnabled: false,
    nextEnabled: true,
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
  }))
})

test('disabling the last workspace auth provider as a platform user re-enables support access', async () => {
  let receivedArgs: unknown = null

  await restoreSupportAccessWhenWorkspaceAuthDisabled({
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    nextEnabled: false,
    isPlatformUser: true,
    prismaClient: {
      setting: {
        async upsert(args: unknown) {
          receivedArgs = args
          return {}
        }
      }
    } as never
  })

  assert.deepEqual(receivedArgs, {
    where: { key: 'tenant:tenant-1:auth:supportAccessEnabled' },
    create: { key: 'tenant:tenant-1:auth:supportAccessEnabled', value: 'true' },
    update: { value: 'true' }
  })
})