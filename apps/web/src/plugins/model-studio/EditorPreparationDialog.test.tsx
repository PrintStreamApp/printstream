import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { readSourceFile } from '../../test-utils/sourceTree'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { EditorPreparationDialog } = await import('./EditorPreparationDialog')
const { createDownloadProgressReporter, observeSavePreparation } = await import('./lib/editorPreparation')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

test('names the concrete browser work while a slice snapshot is prepared', () => {
  render(React.createElement(EditorPreparationDialog, { action: 'slice', onCancel: () => undefined }))

  assert.ok(screen.getByRole('dialog', { name: 'Collecting project changes' }))
  assert.ok(screen.getByText('Gathering the current objects, layout, and settings for this slice.'))
  assert.ok(screen.getByRole('progressbar'))
})

test('explains the browser-side project creation for slicing', () => {
  render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    slicePhase: 'applying',
    onCancel: () => undefined
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Creating project for slicing' }))
  assert.ok(screen.getByText('Creating file to send to slicer.'))
})

test('reports when the prepared project is being uploaded', () => {
  render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    slicePhase: 'uploading',
    transferProgress: { phase: 'uploading-to-server', uploadedBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 },
    onCancel: () => undefined
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Uploading project for slicing' }))
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '50')
  assert.ok(screen.getByText('5.0 MB of 10 MB uploaded.'))
})

test('explains the initial version check and offers an explicit escape', () => {
  let cancelled = false
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    onCancel: () => { cancelled = true }
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Checking for newer saves' }))
  assert.ok(screen.getByText(/saved elsewhere since you opened it/i))
  screen.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(cancelled, true)
})

test('opens save preparation immediately instead of leaving the clicked button spinning', async () => {
  const { source } = await readSourceFile('plugins/model-studio/EditorView.tsx')

  assert.doesNotMatch(source, /showSlowSaveCheck|setShowSlowSaveCheck/)
  assert.match(source, /savePreparationError \|\| preparingSave\s*\n\s*\? 'save'/)
})

test('explains that the project file is created in the browser before upload', () => {
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    savePhase: 'creating',
    onCancel: () => undefined
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Creating project file' }))
  assert.ok(screen.getByText(/writing your edits and settings into a new 3MF file/i))
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), null)
  assert.ok(screen.getByRole('button', { name: 'Cancel' }))
})

test('does not dismiss preparation through the backdrop', () => {
  let cancelled = false
  const { container } = render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    onCancel: () => { cancelled = true }
  }))

  const backdrop = container.ownerDocument.querySelector('.MuiModal-backdrop')
  assert.ok(backdrop)
  fireEvent.click(backdrop)
  assert.equal(cancelled, false)
  assert.ok(screen.getByRole('dialog', { name: 'Collecting project changes' }))
})

test('cancels preparation through Escape while cancellation is safe', () => {
  let cancelled = false
  const { container } = render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    onCancel: () => { cancelled = true }
  }))

  const modalRoot = container.ownerDocument.querySelector('.MuiModal-root')
  assert.ok(modalRoot)
  fireEvent.keyDown(modalRoot, { key: 'Escape' })
  assert.equal(cancelled, true)
})

test('cancels preparation through the close button while cancellation is safe', () => {
  let cancelled = false
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    onCancel: () => { cancelled = true }
  }))

  const closeButton = document.querySelector('.MuiModalClose-root')
  assert.ok(closeButton)
  fireEvent.click(closeButton)
  assert.equal(cancelled, true)
})

test('locks cancellation while a save may already be committing', () => {
  let cancelled = false
  const { container } = render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    finalizing: true,
    onCancel: () => { cancelled = true }
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Adding project to your library' }))
  assert.ok(screen.getByText('This last step cannot be cancelled.'))
  assert.equal(screen.queryByRole('button', { name: 'Cancel' }), null)
  assert.equal(screen.queryByRole('button', { name: 'Close' }), null)
  assert.equal(cancelled, false)

  const modalRoot = container.ownerDocument.querySelector('.MuiModal-root')
  assert.ok(modalRoot)
  fireEvent.keyDown(modalRoot, { key: 'Escape' })
  assert.equal(cancelled, false)
})

test('does not leave a completed browser upload at 100% after save completion starts', () => {
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    finalizing: true,
    transferProgress: { phase: 'uploading-to-server', uploadedBytes: 29 * 1024 * 1024, totalBytes: 29 * 1024 * 1024 },
    onCancel: () => undefined
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Saving project to your library' }))
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), null)
  assert.ok(screen.getByText(/upload complete/i))
  assert.equal(screen.queryByText(/29 MB of 29 MB uploaded/i), null)
})

test('keeps a paced partial transfer within the upload phase', () => {
  render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    slicePhase: 'uploading',
    transferProgress: { phase: 'waiting-for-server', uploadedBytes: 4, totalBytes: 10 },
    onCancel: () => undefined
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Uploading project for slicing' }))
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '40')
  assert.ok(screen.getByText(/waiting to continue/i))
  assert.equal(screen.queryByText(/server gets ready/i), null)
})

test('names a paced wait before the upload starts', () => {
  render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    slicePhase: 'uploading',
    transferProgress: { phase: 'waiting-for-server', uploadedBytes: 0, totalBytes: 10 },
    onCancel: () => undefined
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Uploading project for slicing' }))
  assert.ok(screen.getByText('Waiting to start the upload. It will begin automatically.'))
})

test('allows cancellation while a hidden slice snapshot may already be committing', () => {
  let cancelled = false
  render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    slicePhase: 'finalizing',
    onCancel: () => { cancelled = true }
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Checking project for slicing' }))
  screen.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(cancelled, true)
})

test('keeps uncertain slice preparation cancellable', () => {
  let cancelled = false
  let stopped = false
  render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    slicePhase: 'reconciling',
    onCancel: () => { cancelled = true },
    onStopWaiting: () => { stopped = true }
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Checking whether the project is ready' }))
  screen.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(cancelled, true)
  assert.equal(stopped, false)
  assert.equal(screen.queryByRole('button', { name: 'Stop checking' }), null)
})

test('keeps a preparation failure in an actionable dialog', () => {
  let closed = 0
  let retries = 0
  render(React.createElement(EditorPreparationDialog, {
    action: 'slice',
    error: 'The prepared project did not match this slice.',
    onCancel: () => { closed += 1 },
    onRetry: () => { retries += 1 }
  }))

  assert.ok(screen.getByRole('alertdialog', { name: 'Could not start slicing' }))
  assert.ok(screen.getByText('The prepared project did not match this slice.'))
  assert.equal(screen.queryByRole('progressbar'), null)
  screen.getByRole('button', { name: 'Try again' }).click()
  assert.equal(retries, 1)
  screen.getByRole('button', { name: 'Close' }).click()
  assert.equal(closed, 1)
})

test('keeps a save failure in an actionable dialog', () => {
  let retries = 0
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    error: 'The library could not save this project.',
    onCancel: () => undefined,
    onRetry: () => { retries += 1 }
  }))

  assert.ok(screen.getByRole('alertdialog', { name: 'Could not save project' }))
  assert.ok(screen.getByText('The library could not save this project.'))
  screen.getByRole('button', { name: 'Try again' }).click()
  assert.equal(retries, 1)
})

test('explains an uncertain completion without offering a fake background mode', () => {
  let stopped = false
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    slicePhase: 'reconciling',
    finalizing: true,
    transferProgress: { phase: 'uploading-to-server', uploadedBytes: 29, totalBytes: 29 },
    onCancel: () => undefined,
    onStopWaiting: () => { stopped = true }
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Checking whether the save finished' }))
  assert.ok(screen.getByText(/the project is not being uploaded again/i))
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), null)
  screen.getByRole('button', { name: 'Stop checking' }).click()
  assert.equal(stopped, true)
  assert.equal(screen.queryByRole('button', { name: 'Continue in background' }), null)
})

test('shows independent progress while the saved file is transferred to the library', () => {
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    finalizing: true,
    transferProgress: { phase: 'sending-to-bridge', uploadedBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 },
    onCancel: () => undefined
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Saving project to your library' }))
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '25')
  assert.ok(screen.getByText('2.0 MB of 8.0 MB transferred to your library.'))
  assert.equal(screen.queryByRole('button', { name: 'Cancel' }), null)
})

test('describes the short library commit after transfer without claiming metadata work', () => {
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    finalizing: true,
    transferProgress: { phase: 'finalizing', uploadedBytes: 8, totalBytes: 8 },
    onCancel: () => undefined
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Adding project to your library' }))
  assert.ok(screen.getByText(/creating a new saved version/i))
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), null)
})

test('offers an explicit status retry after bounded reconciliation stops', () => {
  let retries = 0
  let stopped = false
  render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    slicePhase: 'recovery-required',
    finalizing: true,
    recoveryMessage: 'The server did not confirm the upload result in time.',
    onCancel: () => undefined,
    onRetryStatus: () => { retries += 1 },
    onStopWaiting: () => { stopped = true }
  }))

  assert.ok(screen.getByRole('dialog', { name: 'Project save not confirmed' }))
  assert.ok(screen.getByText(/inspect the Library before saving again/i))
  assert.ok(screen.getByText('The server did not confirm the upload result in time.'))
  assert.equal(screen.queryByRole('progressbar'), null)
  assert.equal(screen.queryByRole('button', { name: 'Cancel' }), null)
  screen.getByRole('button', { name: 'Stop checking' }).click()
  assert.equal(stopped, true)
  screen.getByRole('button', { name: 'Retry status check' }).click()
  assert.equal(retries, 1)
})

test('Escape stops an uncertain status check without dismissing through the backdrop', () => {
  let stopped = 0
  const { container } = render(React.createElement(EditorPreparationDialog, {
    action: 'save',
    slicePhase: 'reconciling',
    finalizing: true,
    onCancel: () => undefined,
    onStopWaiting: () => { stopped += 1 }
  }))

  const backdrop = container.ownerDocument.querySelector('.MuiModal-backdrop')
  assert.ok(backdrop)
  fireEvent.click(backdrop)
  assert.equal(stopped, 0)
  const modalRoot = container.ownerDocument.querySelector('.MuiModal-root')
  assert.ok(modalRoot)
  fireEvent.keyDown(modalRoot, { key: 'Escape' })
  assert.equal(stopped, 1)
})

test('renders nothing while the editor is idle', () => {
  const { container } = render(React.createElement(EditorPreparationDialog, { action: null, onCancel: () => undefined }))
  assert.equal(container.childElementCount, 0)
})

test('waits to observe the save before treating an idle render as completion', () => {
  const beforeSaveStarts = observeSavePreparation(true, false, false)
  assert.deepEqual(beforeSaveStarts, { observedBusy: false, close: false })

  const saveStarted = observeSavePreparation(true, true, beforeSaveStarts.observedBusy)
  assert.deepEqual(saveStarted, { observedBusy: true, close: false })

  const saveFailedOrFinished = observeSavePreparation(true, false, saveStarted.observedBusy)
  assert.deepEqual(saveFailedOrFinished, { observedBusy: true, close: true })
})

test('bounds project-download updates while preserving the exact start and finish', () => {
  const updates: Array<{ loadedBytes: number; totalBytes: number | null }> = []
  let currentTime = 0
  const report = createDownloadProgressReporter(
    (progress) => updates.push(progress),
    100,
    () => currentTime
  )

  for (let loadedBytes = 0; loadedBytes <= 1000; loadedBytes += 1) {
    report({ loadedBytes, totalBytes: 1000 })
    currentTime += 1
  }

  assert.equal(updates.length, 11, 'one thousand chunks should not cause one thousand root renders')
  assert.deepEqual(updates[0], { loadedBytes: 0, totalBytes: 1000 })
  assert.deepEqual(updates.at(-1), { loadedBytes: 1000, totalBytes: 1000 })
})
