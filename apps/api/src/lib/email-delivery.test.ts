import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { HttpError } from './http-error.js'
import { emailTransportRegistry, isEmailDeliveryConfigured, sendEmail, type EmailInput } from './email-delivery.js'

afterEach(() => {
  emailTransportRegistry.clear()
})

function fakeTransport(name: string, configured: boolean, sink?: EmailInput[]) {
  return {
    name,
    isConfigured: () => configured,
    send: async (input: EmailInput) => {
      sink?.push(input)
    }
  }
}

test('sendEmail throws when no transport is configured', async () => {
  emailTransportRegistry.clear()
  assert.equal(await isEmailDeliveryConfigured(), false)
  await assert.rejects(
    () => sendEmail({ to: 'a@b.co', subject: 's', text: 't' }),
    (error: unknown) => error instanceof HttpError && (error as HttpError).statusCode === 503
  )
})

test('sendEmail uses the first configured transport', async () => {
  const sink: EmailInput[] = []
  emailTransportRegistry.clear()
  emailTransportRegistry.register(fakeTransport('unconfigured', false, sink))
  emailTransportRegistry.register(fakeTransport('configured', true, sink))
  emailTransportRegistry.register(fakeTransport('also-configured', true, sink))

  assert.equal(await isEmailDeliveryConfigured(), true)
  await sendEmail({ to: 'a@b.co', subject: 'Hi', text: 'Body' })
  assert.equal(sink.length, 1)
  assert.equal(sink[0]?.to, 'a@b.co')
  assert.equal(sink[0]?.subject, 'Hi')
  assert.equal(sink[0]?.text, 'Body')
  assert.match(sink[0]?.html ?? '', /<h1[^>]*>Hi<\/h1>/)
  assert.match(sink[0]?.html ?? '', /printstream\.app\/icon-512\.png/)
  assert.match(sink[0]?.html ?? '', /<p[^>]*>Body<\/p>/)
  assert.match(sink[0]?.html ?? '', /href="https:\/\/printstream\.app"/)
})

test('plain-text fallback escapes HTML in the branded message', async () => {
  const sink: EmailInput[] = []
  emailTransportRegistry.clear()
  emailTransportRegistry.register(fakeTransport('smtp', true, sink))

  await sendEmail({ to: 'a@b.co', subject: '<Account>', text: '<script>alert(1)</script>' })

  assert.match(sink[0]?.html ?? '', /&lt;Account&gt;/)
  assert.match(sink[0]?.html ?? '', /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(sink[0]?.html ?? '', /<script>/)
})

test('register returns a disposer that removes the transport', async () => {
  emailTransportRegistry.clear()
  const off = emailTransportRegistry.register(fakeTransport('smtp', true))
  assert.equal(await isEmailDeliveryConfigured(), true)
  off()
  assert.equal(await isEmailDeliveryConfigured(), false)
})
