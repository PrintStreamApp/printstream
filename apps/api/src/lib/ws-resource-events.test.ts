import assert from 'node:assert/strict'
import { test } from 'node:test'
import { broadcastLibraryChangedDebounced } from './ws-resource-events.js'
import { wsBroadcaster } from './ws-server.js'

/** Wait past the debounce window (uses a short real delay; the API default is 500ms). */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('broadcastLibraryChangedDebounced coalesces a warm burst into one broadcast per workspace', async () => {
  const seen: Array<{ type: string; workspaceId: string | null }> = []
  const original = wsBroadcaster.broadcast.bind(wsBroadcaster)
  wsBroadcaster.broadcast = ((event, workspaceId) => {
    seen.push({ type: event.type, workspaceId })
  }) as typeof wsBroadcaster.broadcast
  try {
    // A listing with several stale rows lands several warms back to back — the exact burst
    // this exists to coalesce, because each broadcast refetches every client's library list.
    broadcastLibraryChangedDebounced('workspace-a', 30)
    broadcastLibraryChangedDebounced('workspace-a', 30)
    broadcastLibraryChangedDebounced('workspace-a', 30)
    // A different workspace's warm must not be folded into workspace-a's signal.
    broadcastLibraryChangedDebounced('workspace-b', 30)
    assert.equal(seen.length, 0, 'trailing debounce: nothing fires inside the window')

    await wait(120)
    assert.deepEqual(
      seen.map((entry) => entry.workspaceId).sort(),
      ['workspace-a', 'workspace-b']
    )
    assert.equal(seen.every((entry) => entry.type === 'resource.changed'), true)

    // A warm landing after the window fired reschedules a fresh signal.
    broadcastLibraryChangedDebounced('workspace-a', 30)
    await wait(120)
    assert.equal(seen.filter((entry) => entry.workspaceId === 'workspace-a').length, 2)
  } finally {
    wsBroadcaster.broadcast = original
  }
})
