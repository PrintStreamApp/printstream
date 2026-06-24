import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adminSetPasswordRequestSchema,
  authMethodSchema,
  bootstrapPasswordAdminRequestSchema,
  changeOwnPasswordRequestSchema,
  passwordSignInRequestSchema,
  passwordValueSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH
} from './auth.js'

test('authMethodSchema accepts the password method', () => {
  assert.equal(authMethodSchema.parse('password'), 'password')
  assert.equal(authMethodSchema.safeParse('telepathy').success, false)
})

test('passwordValueSchema enforces the length policy', () => {
  assert.equal(passwordValueSchema.safeParse('short').success, false)
  assert.equal(passwordValueSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success, true)
  assert.equal(passwordValueSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success, false)
})

test('passwordValueSchema does not trim surrounding whitespace', () => {
  const padded = `  ${'a'.repeat(PASSWORD_MIN_LENGTH)}  `
  assert.equal(passwordValueSchema.parse(padded), padded)
})

test('bootstrapPasswordAdminRequestSchema requires a policy-compliant password', () => {
  assert.equal(bootstrapPasswordAdminRequestSchema.safeParse({ email: 'a@b.co', password: 'short' }).success, false)
  const parsed = bootstrapPasswordAdminRequestSchema.parse({
    email: 'admin@example.com',
    displayName: 'Admin',
    password: 'correct horse battery'
  })
  assert.equal(parsed.email, 'admin@example.com')
})

test('passwordSignInRequestSchema accepts any non-empty password (legacy/sign-in bound)', () => {
  assert.equal(passwordSignInRequestSchema.safeParse({ email: 'a@b.co', password: '' }).success, false)
  assert.equal(passwordSignInRequestSchema.safeParse({ email: 'a@b.co', password: 'short' }).success, true)
})

test('change and admin-set schemas enforce the new-password policy', () => {
  assert.equal(changeOwnPasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success, false)
  assert.equal(changeOwnPasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'a'.repeat(PASSWORD_MIN_LENGTH) }).success, true)
  assert.equal(adminSetPasswordRequestSchema.safeParse({ password: 'short' }).success, false)
  assert.equal(adminSetPasswordRequestSchema.safeParse({ password: 'a'.repeat(PASSWORD_MIN_LENGTH) }).success, true)
})
