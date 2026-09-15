import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { PublicSlicingJob } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react')
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

test('uses the shared result panel and keeps public actions together in the footer', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new Blob(['not-a-zip']))

  try {
    render(React.createElement(PublicSlicingDialog, {
      session: {
        accessToken: 'token',
        job: job({
          status: 'ready',
          message: 'Ready to download',
          outputFileName: 'project.gcode.3mf',
          outputSizeBytes: 9,
          metadata: {
            estimatedPrintTimeSeconds: 600,
            estimatedPrepareTimeSeconds: 30,
            estimatedFilamentWeightGrams: 5,
            materials: [{ id: 1, weightGrams: 5, lengthMm: 2010 }]
          },
          filamentMappings: [{
            projectFilamentId: 1,
            material: 'PLA Matte',
            color: '#111111',
            source: 'manual'
          }]
        })
      },
      onSessionChange: () => undefined,
      onClose: () => undefined
    }))

    const dialog = screen.getByRole('dialog', { name: 'Slice results' })
    assert.ok(within(dialog).getByText('project'))
    assert.ok(within(dialog).getByText('Ready'))
    assert.ok(within(dialog).getByText('PLA Matte'))
    assert.ok(within(dialog).getByText('5.0 g · 2.01 m'))

    const actions = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((label) => label === 'Cancel' || label === 'Preview G-code' || label === 'Download G-code')
    assert.deepEqual(actions, ['Cancel', 'Preview G-code', 'Download G-code'])

    await waitFor(() => assert.ok(within(dialog).getByRole('button', { name: 'Retry G-code preview' })))
  } finally {
    globalThis.fetch = originalFetch
  }
})
