import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { toast, type ToastEntry } from './toast'

function readEntries(): ToastEntry[] {
  let captured: ToastEntry[] = []
  const unsubscribe = toast.subscribe((entries) => { captured = entries })
  unsubscribe()
  return captured
}

beforeEach(() => { toast.clear() })

test('toast folds a repeated identical message into one counted entry', () => {
  const first = toast.error('Printer is offline')
  const second = toast.error('Printer is offline')
  toast.error('Printer is offline')

  const entries = readEntries()
  assert.equal(second, first, 'a repeat returns the id of the toast already on screen')
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.count, 3)
})

test('toast keeps a different message or tone as its own entry', () => {
  toast.error('Printer is offline')
  toast.error('Bridge is offline')
  toast.success('Printer is offline')

  assert.equal(readEntries().length, 3)
})

test('toast never folds an entry a caller still holds a handle to', () => {
  // Actions, close callbacks and loading/progress toasts are live handles the
  // caller updates or dismisses by id; merging them would drop one of those.
  const action = { label: 'Retry', onClick: () => {} }
  toast.show({ message: 'Upload failed', action })
  toast.show({ message: 'Upload failed', action })
  toast.show({ message: 'Sending', tone: 'neutral', durationMs: 0, loading: true })
  toast.show({ message: 'Sending', tone: 'neutral', durationMs: 0, loading: true })

  assert.equal(readEntries().length, 4)
})

test('one dismiss clears a folded entry and every repeat with it', () => {
  const id = toast.error('Printer is offline')
  toast.error('Printer is offline')
  toast.error('Printer is offline')

  toast.dismiss(id)

  assert.deepEqual(readEntries(), [])
})
