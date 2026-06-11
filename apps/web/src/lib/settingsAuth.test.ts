import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSettingsAuthState } from './settingsAuth'

test('resolveSettingsAuthState keeps auth management available during setup while auth is still disabled', () => {
  assert.deepEqual(
    resolveSettingsAuthState({
      authEnabled: false,
      capabilities: {
        canViewAuth: false,
        canManageAuthProviders: false,
        canManageSettings: false,
        canManageSupportAccess: false,
        canManageTenants: false,
        canManagePlugins: false,
        canViewLogs: false
      },
      setupRequired: true,
      providers: [{
        id: 'auth-local',
        label: 'Local Auth',
        enabled: true,
        methods: ['passkey'],
        setupRequired: true,
        capabilities: {
          recentVerificationMethods: [],
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
        }
      }]
    }).canManageAuthProviders,
    true
  )
})

test('resolveSettingsAuthState requires auth access view once auth is enabled', () => {
  assert.deepEqual(
    resolveSettingsAuthState({
      authEnabled: true,
      capabilities: {
        canViewAuth: false,
        canManageAuthProviders: false,
        canManageSettings: false,
        canManageSupportAccess: false,
        canManageTenants: false,
        canManagePlugins: false,
        canViewLogs: false
      },
      setupRequired: false,
      providers: [{
        id: 'auth-local',
        label: 'Local Auth',
        enabled: true,
        methods: ['passkey'],
        setupRequired: false,
        capabilities: {
          recentVerificationMethods: [],
          signIn: true,
          setup: false,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
        }
      }]
    }).canViewAuth,
    false
  )
})

test('resolveSettingsAuthState keeps users and roles hidden while auth is disabled outside setup', () => {
  assert.deepEqual(
    resolveSettingsAuthState({
      authEnabled: false,
      capabilities: {
        canViewAuth: false,
        canManageAuthProviders: false,
        canManageSettings: false,
        canManageSupportAccess: false,
        canManageTenants: false,
        canManagePlugins: false,
        canViewLogs: false
      },
      setupRequired: false,
      providers: [{
        id: 'auth-local',
        label: 'Local Auth',
        enabled: false,
        methods: ['passkey'],
        setupRequired: false,
        capabilities: {
          recentVerificationMethods: [],
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
        }
      }]
    }).canViewAuth,
    false
  )
})

test('resolveSettingsAuthState hides users and roles while auth is disabled even with broad capabilities', () => {
  assert.deepEqual(
    resolveSettingsAuthState({
      authEnabled: false,
      capabilities: {
        canViewAuth: true,
        canManageAuthProviders: true,
        canManageSettings: true,
        canManageSupportAccess: true,
        canManageTenants: true,
        canManagePlugins: true,
        canViewLogs: true
      },
      setupRequired: false,
      providers: [{
        id: 'auth-local',
        label: 'Local Auth',
        enabled: false,
        methods: ['passkey'],
        setupRequired: false,
        capabilities: {
          recentVerificationMethods: [],
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
        }
      }]
    }).canViewAuth,
    false
  )
})