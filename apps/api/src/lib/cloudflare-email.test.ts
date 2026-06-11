process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCloudflareEmailSender } from './cloudflare-email.js'
import { HttpError } from './http-error.js'

test('Cloudflare email sender posts configured account id and message payload', async () => {
  const requests: Array<{ url: string, init: RequestInit }> = []
  const sender = createCloudflareEmailSender({
    accountId: 'account-id-123',
    apiToken: 'test-token',
    fromEmail: 'noreply@mail.printstream.app',
    fromName: 'PrintStream'
  }, async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })

  await sender({
    to: 'operator@example.com',
    subject: 'Hello from PrintStream',
    text: 'Plain text body',
    html: '<p>Plain text body</p>'
  })

  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.ok(request)
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/account-id-123/email/sending/send')
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(request.init.headers, {
    authorization: 'Bearer test-token',
    'content-type': 'application/json'
  })
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    to: 'operator@example.com',
    from: 'PrintStream <noreply@mail.printstream.app>',
    subject: 'Hello from PrintStream',
    text: 'Plain text body',
    html: '<p>Plain text body</p>'
  })
})

test('Cloudflare email sender maps provider HTTP failures to a safe error', async () => {
  const sender = createCloudflareEmailSender({
    accountId: 'account-id-123',
    apiToken: 'test-token',
    fromEmail: 'noreply@mail.printstream.app',
    fromName: null
  }, async () => new Response(JSON.stringify({ success: false }), { status: 403 }))

  await assert.rejects(
    sender({
      to: 'operator@example.com',
      subject: 'Hello from PrintStream',
      text: 'Plain text body'
    }),
    (error) => error instanceof HttpError
      && error.statusCode === 502
      && error.message === 'Email delivery failed.'
  )
})

test('Cloudflare email sender treats unsuccessful provider responses as failures', async () => {
  const sender = createCloudflareEmailSender({
    accountId: 'account-id-123',
    apiToken: 'test-token',
    fromEmail: 'noreply@mail.printstream.app',
    fromName: null
  }, async () => new Response(JSON.stringify({ success: false }), { status: 200 }))

  await assert.rejects(
    sender({
      to: 'operator@example.com',
      subject: 'Hello from PrintStream',
      text: 'Plain text body'
    }),
    (error) => error instanceof HttpError
      && error.statusCode === 502
      && error.message === 'Email delivery failed.'
  )
})