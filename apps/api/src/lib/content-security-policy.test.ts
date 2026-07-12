import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildContentSecurityPolicy } from './content-security-policy.js'

const policy = buildContentSecurityPolicy()
const directives = new Map(
  policy.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...sources] = part.split(/\s+/)
    return [name, sources] as const
  })
)

test('allows blob:/data: images and media for camera frames and thumbnails', () => {
  for (const directive of ['img-src', 'media-src']) {
    const sources = directives.get(directive) ?? []
    assert.ok(sources.includes("'self'"), `${directive} should include 'self'`)
    assert.ok(sources.includes('blob:'), `${directive} should include blob:`)
    assert.ok(sources.includes('data:'), `${directive} should include data:`)
  }
})

const PADDLE = 'https://*.paddle.com'
const CF_INSIGHTS_SCRIPT = 'https://static.cloudflareinsights.com'
const CF_INSIGHTS_BEACON = 'https://cloudflareinsights.com'

test('locks down the high-value directives', () => {
  assert.deepEqual(directives.get('default-src'), ["'self'"])
  assert.deepEqual(directives.get('object-src'), ["'none'"])
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"])
  assert.deepEqual(directives.get('base-uri'), ["'self'"])
  assert.deepEqual(directives.get('form-action'), ["'self'"])
})

test('cross-origin allow-list is exactly Paddle checkout + Cloudflare insights', () => {
  // The cloud checkout needs Paddle.js + its iframe/APIs, and Cloudflare's
  // edge-injected Web Analytics beacon needs its script + measurement hosts.
  // Nothing else may be cross-origin.
  const expected: Record<string, string[]> = {
    'script-src': [PADDLE, CF_INSIGHTS_SCRIPT],
    'connect-src': [PADDLE, CF_INSIGHTS_BEACON],
    'frame-src': [PADDLE],
    'img-src': [PADDLE],
    'style-src': [PADDLE]
  }
  for (const [directive, hosts] of Object.entries(expected)) {
    const sources = directives.get(directive) ?? []
    const crossOrigin = sources.filter((s) => s.startsWith('http'))
    assert.deepEqual(crossOrigin, hosts, `${directive} cross-origin allow-list`)
  }
  assert.ok((directives.get('connect-src') ?? []).includes("'self'"))
})

test('does not allow unsafe-eval or unexpected cross-origin script', () => {
  const scriptSrc = directives.get('script-src') ?? []
  assert.ok(scriptSrc.includes("'self'"))
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), 'production script-src must not allow eval')
  assert.ok(scriptSrc.every((s) => !s.startsWith('http') || s === PADDLE || s === CF_INSIGHTS_SCRIPT), 'only Paddle + CF insights allowed cross-origin')
})

test('allows the model-studio web worker (worker-src self blob:)', () => {
  const workerSrc = directives.get('worker-src') ?? []
  assert.ok(workerSrc.includes("'self'") && workerSrc.includes('blob:'))
})

test('analytics origin extends exactly script-src and connect-src', () => {
  const origin = 'https://analytics.example.com'
  const extended = new Map(
    buildContentSecurityPolicy({ analyticsOrigin: origin }).split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [name, ...sources] = part.split(/\s+/)
      return [name, sources] as const
    })
  )
  for (const [directive, sources] of extended) {
    const expectIt = directive === 'script-src' || directive === 'connect-src'
    assert.equal(sources.includes(origin), expectIt, `${directive} analytics allowance`)
  }
})

test('report-uri is appended when a sink is configured, omitted otherwise', () => {
  assert.ok(!policy.includes('report-uri'))
  const withSink = buildContentSecurityPolicy({ reportUri: '/api/csp-report' })
  assert.ok(withSink.endsWith('report-uri /api/csp-report'))
})
