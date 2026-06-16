import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authBootstrapSchema, authProviderBootstrapSchema } from './auth.js'

test('authProviderBootstrapSchema accepts oauth providers', () => {
  assert.deepEqual(authProviderBootstrapSchema.parse({
    id: 'auth-sso',
    label: 'Single Sign-On',
    enabled: true,
    methods: ['oauth'],
    setupRequired: false,
    capabilities: {
      signIn: true,
      setup: true,
      accountSecurity: false,
      adminUserProvisioning: false,
      adminUserCredentials: false,
      recentVerificationMethods: []
    }
  }), {
    id: 'auth-sso',
    label: 'Single Sign-On',
    enabled: true,
    methods: ['oauth'],
    setupRequired: false,
    capabilities: {
      signIn: true,
      setup: true,
      accountSecurity: false,
      adminUserProvisioning: false,
      adminUserCredentials: false,
      recentVerificationMethods: []
    }
  })
})

test('authBootstrapSchema preserves mixed provider methods', () => {
  assert.deepEqual(authBootstrapSchema.parse({
    authEnabled: true,
    platformAuthEnabled: true,
    setupRequired: false,
    tenant: null,
    memberTenants: [],
    availableTenants: [],
    tenantHasConnectedBridges: false,
    providers: [
      {
        id: 'auth-local',
        label: 'Local Auth',
        enabled: true,
        methods: ['passkey', 'email-code'],
        setupRequired: false,
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
          recentVerificationMethods: ['passkey', 'email-code']
        }
      },
      {
        id: 'auth-sso',
        label: 'Single Sign-On',
        enabled: true,
        methods: ['oauth'],
        setupRequired: false,
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: false,
          adminUserProvisioning: false,
          adminUserCredentials: false,
          recentVerificationMethods: []
        }
      }
    ],
    actor: { type: 'anonymous', isPlatformUser: false },
    permissions: [],
    capabilities: {
      canViewAuth: true,
      canManageAuthProviders: true,
      canManageSettings: true,
      canManageSupportAccess: true,
      canManageTenants: true,
      canManagePlugins: true,
      canViewLogs: true
    },
    runtimePolicy: { demoMode: false, managedBridge: false }
  }), {
    authEnabled: true,
    platformAuthEnabled: true,
    setupRequired: false,
    tenant: null,
    memberTenants: [],
    availableTenants: [],
    tenantHasConnectedBridges: false,
    providers: [
      {
        id: 'auth-local',
        label: 'Local Auth',
        enabled: true,
        methods: ['passkey', 'email-code'],
        setupRequired: false,
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
          recentVerificationMethods: ['passkey', 'email-code']
        }
      },
      {
        id: 'auth-sso',
        label: 'Single Sign-On',
        enabled: true,
        methods: ['oauth'],
        setupRequired: false,
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: false,
          adminUserProvisioning: false,
          adminUserCredentials: false,
          recentVerificationMethods: []
        }
      }
    ],
    actor: { type: 'anonymous', isPlatformUser: false },
    permissions: [],
    capabilities: {
      canViewAuth: true,
      canManageAuthProviders: true,
      canManageSettings: true,
      canManageSupportAccess: true,
      canManageTenants: true,
      canManagePlugins: true,
      canViewLogs: true
    },
    runtimePolicy: { demoMode: false, managedBridge: false }
  })
})

test('authProviderBootstrapSchema fills default provider capabilities', () => {
  assert.deepEqual(authProviderBootstrapSchema.parse({
    id: 'auth-sso',
    label: 'Single Sign-On',
    enabled: true,
    methods: ['oauth']
  }), {
    id: 'auth-sso',
    label: 'Single Sign-On',
    enabled: true,
    methods: ['oauth'],
    setupRequired: false,
    capabilities: {
      signIn: true,
      setup: false,
      accountSecurity: false,
      adminUserProvisioning: false,
      adminUserCredentials: false,
      recentVerificationMethods: []
    }
  })
})