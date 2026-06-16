import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import React from 'react'
import type { BridgeDebugCaptureStatus, BridgeListResponse, BridgeSummary } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { BridgeDebugCaptureBanner } from './BridgeDebugCaptureBanner'

const dom = installJsdomGlobals()

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function makeBridge(debugCapture: BridgeDebugCaptureStatus): BridgeSummary {
  return {
    id: 'bridge-1',
    name: 'Wormpop Labs',
    printerCount: 1,
    lastSeenAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    connectionStats: {
      connected: true,
      connectedAt: new Date(0).toISOString(),
      pendingRpcCount: 0,
      activeCameraWatchCount: 0,
      activePrinterFtpCount: 0
    },
    update: {
      status: 'current',
      currentReleaseFingerprint: null,
      latestReleaseFingerprint: null,
      currentBuildRevision: null,
      latestBuildRevision: null,
      latestReleasedAt: null,
      protocolVersion: 1,
      runnerAbiVersion: 'sea-node22-v1',
      lastCheckedAt: null,
      lastError: null,
      manualUpdateCommand: null
    },
    debugCapture
  }
}

function renderWithBridges(bridges: BridgeSummary[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData<BridgeListResponse>(['bridges'], { bridges })
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider>
        <BridgeDebugCaptureBanner />
      </CssVarsProvider>
    </QueryClientProvider>
  )
}

const inactive: BridgeDebugCaptureStatus = {
  active: false,
  startedAt: null,
  stoppedAt: null,
  frameCount: 0,
  bytes: 0,
  droppedFrames: 0,
  truncated: false,
  hasCapture: false
}

test('shows a recording banner with stop and download actions when a capture is active', () => {
  const view = renderWithBridges([
    makeBridge({ ...inactive, active: true, startedAt: new Date(0).toISOString(), frameCount: 42, hasCapture: true })
  ])

  assert.ok(view.getByText(/Debug traffic capture is running/))
  assert.ok(view.getByText(/42 frames/))
  assert.ok(view.getByRole('button', { name: 'Stop capture' }))
  assert.ok(view.getByRole('link', { name: 'Download' }))
})

test('renders nothing when no bridge is capturing', () => {
  const view = renderWithBridges([makeBridge(inactive)])
  assert.equal(view.queryByText(/Debug traffic capture is running/), null)
  assert.equal(view.queryByRole('button', { name: 'Stop capture' }), null)
})
