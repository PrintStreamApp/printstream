import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { PublicSlicingJob } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, render, screen } = await import('@testing-library/react')
const { PublicSlicingDialog } = await import('./PublicSlicingDialog')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

function job(overrides: Partial<PublicSlicingJob> = {}): PublicSlicingJob {
  return {
    id: 'job-1',
    fileName: 'project.3mf',
    sizeBytes: 100,
    uploadedBytes: 25,
    status: 'uploading',
    queuePosition: null,
    estimatedWaitSeconds: null,
    message: 'Uploading prepared project',
    error: null,
    outputFileName: null,
    outputSizeBytes: null,
    createdAt: '2026-09-12T12:00:00.000Z',
    updatedAt: '2026-09-12T12:00:00.000Z',
    expiresAt: '2026-09-12T13:00:00.000Z',
    ...overrides
  }
}

test('adopts upload status changes reported through the parent session', () => {
  const props = {
    onSessionChange: () => undefined,
    onClose: () => undefined
  }
  const { rerender } = render(React.createElement(PublicSlicingDialog, {
    ...props,
    session: { accessToken: 'token', job: job() }
  }))

  assert.ok(screen.getByText('Uploading prepared project'))

  rerender(React.createElement(PublicSlicingDialog, {
    ...props,
    session: {
      accessToken: 'token',
      job: job({
        uploadedBytes: 100,
        status: 'cancelled',
        message: 'Slicing cancelled'
      })
    }
  }))

  assert.ok(screen.getByText('Slicing cancelled'))
  assert.equal(screen.queryByText('Uploading prepared project'), null)
  assert.ok(screen.getByRole('button', { name: 'Close' }))
})
