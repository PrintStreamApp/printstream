import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import React from 'react'
import { BRIDGE_CRASH_LOOP_THRESHOLD, type BridgeCrashHealth, type BridgeListResponse, type BridgeSummary } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { BridgeCrashBanner } from './BridgeCrashBanner'

const dom = installJsdomGlobals()

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function makeBridge(crash: BridgeCrashHealth): BridgeSummary {
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
    debugCapture: {
      active: false,
      startedAt: null,
      stoppedAt: null,
      frameCount: 0,
      bytes: 0,
      droppedFrames: 0,
      truncated: false,
      hasCapture: false
    },
    backup: {
      configured: false,
      directory: null,
      intervalHours: null,
      running: false,
      snapshotCount: 0,
      lastBackupAt: null,
      nextDueAt: null,
      lastError: null
    },
    crash
  }
}

function renderWithBridges(bridges: BridgeSummary[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  queryClient.setQueryData<BridgeListResponse>(['bridges'], { bridges })
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider>
        <BridgeCrashBanner />
      </CssVarsProvider>
    </QueryClientProvider>
  )
}

const loopingCrash: BridgeCrashHealth = {
  lastCrashAt: new Date().toISOString(),
  recentCrashCount: BRIDGE_CRASH_LOOP_THRESHOLD,
  lastReason: 'Error: connack timeout'
}

test('shows a crash-loop banner with a clear action', () => {
  const view = renderWithBridges([makeBridge(loopingCrash)])

  assert.ok(view.getByText(/is crash-looping/))
  assert.ok(view.getByText(`${BRIDGE_CRASH_LOOP_THRESHOLD} crashes in the last hour`))
  assert.ok(view.getByText('Error: connack timeout'))
  assert.ok(view.getByRole('button', { name: 'Clear crash history' }))
})

test('renders nothing once the crash summary is cleared', () => {
  const view = renderWithBridges([makeBridge({ lastCrashAt: null, recentCrashCount: 0, lastReason: null })])

  assert.equal(view.queryByText(/is crash-looping/), null)
  assert.equal(view.queryByRole('button', { name: 'Clear crash history' }), null)
})

test('renders nothing for a single crash — that is the settings chip, not an app-wide banner', () => {
  const view = renderWithBridges([
    makeBridge({ lastCrashAt: new Date().toISOString(), recentCrashCount: 1, lastReason: null })
  ])

  assert.equal(view.queryByText(/is crash-looping/), null)
})
