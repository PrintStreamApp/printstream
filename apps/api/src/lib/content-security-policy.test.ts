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

test('locks down the high-value directives', () => {
  assert.deepEqual(directives.get('default-src'), ["'self'"])
  assert.deepEqual(directives.get('object-src'), ["'none'"])
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"])
  assert.deepEqual(directives.get('base-uri'), ["'self'"])
  assert.deepEqual(directives.get('form-action'), ["'self'"])
})

test('only Paddle checkout is allow-listed cross-origin (no other hosts)', () => {
  // The cloud checkout needs Paddle.js + its iframe/APIs; nothing else may be
  // cross-origin. Every non-keyword source must be 'self' or the Paddle host.
  for (const directive of ['script-src', 'connect-src', 'frame-src', 'img-src', 'style-src']) {
    const sources = directives.get(directive) ?? []
    const crossOrigin = sources.filter((s) => s.startsWith('http'))
    assert.deepEqual(crossOrigin, crossOrigin.length ? [PADDLE] : [], `${directive} may only allow Paddle cross-origin`)
  }
  assert.ok((directives.get('connect-src') ?? []).includes("'self'"))
})

test('does not allow unsafe-eval or non-Paddle cross-origin script', () => {
  const scriptSrc = directives.get('script-src') ?? []
  assert.ok(scriptSrc.includes("'self'"))
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), 'production script-src must not allow eval')
  assert.ok(scriptSrc.every((s) => !s.startsWith('http') || s === PADDLE), 'only Paddle allowed cross-origin')
})

test('allows the model-studio web worker (worker-src self blob:)', () => {
  const workerSrc = directives.get('worker-src') ?? []
  assert.ok(workerSrc.includes("'self'") && workerSrc.includes('blob:'))
})
