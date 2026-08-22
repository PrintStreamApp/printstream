import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { installFeatureUsageCapture, registerFeatureUsageRecorder, type FeatureUsageSample } from './feature-usage.js'

function buildRequest(overrides: {
  workspaceId?: string | null
  actorType?: 'user' | 'service-account' | 'anonymous'
  method?: string
  path?: string
} = {}): Request {
  const actorType = overrides.actorType ?? 'user'
  return {
    method: overrides.method ?? 'POST',
    path: overrides.path ?? '/api/library',
    workspace: overrides.workspaceId === null
      ? null
      : { id: overrides.workspaceId ?? 'ws-1', slug: 'ws', name: 'Workspace' },
    auth: { actor: { type: actorType } }
  } as unknown as Request
}

function buildResponse(statusCode = 200): Response {
  const emitter = new EventEmitter() as EventEmitter & { statusCode: number }
  emitter.statusCode = statusCode
  return emitter as unknown as Response
}

function runCapture(request: Request, response: Response): boolean {
  let nextCalled = false
  installFeatureUsageCapture()(request, response, () => {
    nextCalled = true
  })
  return nextCalled
}

test('passes through and records nothing when no recorder is registered', () => {
  registerFeatureUsageRecorder(null)
  const response = buildResponse()
  assert.equal(runCapture(buildRequest(), response), true)
  // No listener means no recorder work is even scheduled.
  assert.equal(response.listenerCount('finish'), 0)
})

test('reports a workspace request to the recorder with the finished status code', () => {
  const samples: FeatureUsageSample[] = []
  registerFeatureUsageRecorder((sample) => samples.push(sample))
  try {
    const response = buildResponse(201)
    assert.equal(runCapture(buildRequest({ method: 'POST', path: '/api/library/upload' }), response), true)
    response.emit('finish')
    assert.deepEqual(samples, [{
      workspaceId: 'ws-1',
      actorType: 'user',
      method: 'POST',
      path: '/api/library/upload',
      statusCode: 201
    }])
  } finally {
    registerFeatureUsageRecorder(null)
  }
})

test('skips anonymous and non-workspace requests', () => {
  const samples: FeatureUsageSample[] = []
  registerFeatureUsageRecorder((sample) => samples.push(sample))
  try {
    for (const request of [buildRequest({ actorType: 'anonymous' }), buildRequest({ workspaceId: null })]) {
      const response = buildResponse()
      assert.equal(runCapture(request, response), true)
      response.emit('finish')
    }
    assert.deepEqual(samples, [])
  } finally {
    registerFeatureUsageRecorder(null)
  }
})

test('a throwing recorder is swallowed and never breaks the finish listener', () => {
  registerFeatureUsageRecorder(() => {
    throw new Error('recorder boom')
  })
  try {
    const response = buildResponse()
    assert.equal(runCapture(buildRequest(), response), true)
    assert.doesNotThrow(() => response.emit('finish'))
  } finally {
    registerFeatureUsageRecorder(null)
  }
})
