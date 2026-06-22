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

test('locks down the high-value directives', () => {
  assert.deepEqual(directives.get('default-src'), ["'self'"])
  assert.deepEqual(directives.get('object-src'), ["'none'"])
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"])
  assert.deepEqual(directives.get('base-uri'), ["'self'"])
  assert.deepEqual(directives.get('connect-src'), ["'self'"])
  assert.deepEqual(directives.get('form-action'), ["'self'"])
})

test('does not allow cross-origin script or unsafe-eval', () => {
  const scriptSrc = directives.get('script-src') ?? []
  assert.ok(scriptSrc.includes("'self'"))
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), 'production script-src must not allow eval')
  assert.ok(!scriptSrc.some((s) => s.startsWith('http')), 'no cross-origin script sources')
})

test('allows the model-studio web worker (worker-src self blob:)', () => {
  const workerSrc = directives.get('worker-src') ?? []
  assert.ok(workerSrc.includes("'self'") && workerSrc.includes('blob:'))
})
