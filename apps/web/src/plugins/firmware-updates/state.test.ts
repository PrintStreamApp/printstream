import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { printerStatusSchema } from '@printstream/shared'
import {
  UPDATES_STORAGE_KEY,
  parseFirmwareStatusEvent,
  firmwareStillPendingInstall,
  formatFirmwareChipLabel,
  firmwareChipColor,
  formatModuleLabel,
  getDefaultSelectedVersion,
  getInstallableVersions,
  getModuleFirmware,
  getUpdatesStorageKey,
  getSelectedPrerequisite,
  getSelectedReleaseNotes,
  isActiveUploadStatus,
  isDowngradeSelection,
  isInstallableVersionSelected,
  isOfflineUpdateBlocked,
  isUploadedVersionLatest,
  parseUploadProgressEvent,
  readStoredUpdates,
  shouldInvalidateFirmwareUpdates,
  shouldPollUploadProgress,
  shouldShowFirmwareUpdateChip,
  writeStoredUpdates,
  type FirmwareStatusSnapshot,
  type UpdateReport,
  type UpdatesResponse,
  type UploadProgress
} from './state.js'

const sampleUpdate: UpdateReport = {
  printerId: 'printer-1',
  printerName: 'Printer 1',
  model: 'P1S',
  online: true,
  currentVersion: '01.09.00.00',
  sdCardPresent: true,
  latestVersion: '01.10.00.00',
  updateAvailable: true,
  downloadUrl: 'https://example.com/01.10.00.00.zip',
  releaseNotes: '# Version 01.10.00.00',
  offlineUpdate: { minimumVersion: '01.07.00.00', belowMinimum: false },
  modules: [
    { name: 'mc', version: '00.00.30.04', hardwareVersion: null, isAms: false },
    { name: 'ams/0', version: '00.00.06.49', hardwareVersion: 'AMS08', isAms: true }
  ],
  availableVersions: [
    {
      version: '01.10.00.00',
      fileAvailable: true,
      releaseNotes: '# Version 01.10.00.00',
      releaseTime: '2026-04-13T03:07:41Z',
      prerequisite: null
    },
    {
      version: '01.09.01.00',
      fileAvailable: true,
      releaseNotes: '# Version 01.09.01.00',
      releaseTime: '2026-01-14T00:00:00Z',
      prerequisite: null
    },
    {
      version: '01.08.02.00',
      fileAvailable: false,
      releaseNotes: null,
      releaseTime: '2025-06-03T09:38:31Z',
      prerequisite: null
    }
  ]
}

afterEach(() => {
  deleteMockWindow()
})

test('storage helpers round-trip cached updates per workspace and ignore invalid JSON', () => {
  const storage = createMockStorage()
  setMockWindow(storage)

  const updates: UpdatesResponse = {
    updatesAvailable: 1,
    updates: [sampleUpdate]
  }
  const otherUpdates: UpdatesResponse = {
    updatesAvailable: 0,
    updates: []
  }

  assert.equal(readStoredUpdates('tenant-1'), undefined)
  writeStoredUpdates('tenant-1', updates)
  writeStoredUpdates('tenant-2', otherUpdates)
  assert.deepEqual(readStoredUpdates('tenant-1'), updates)
  assert.deepEqual(readStoredUpdates('tenant-2'), otherUpdates)
  assert.equal(storage.getItem(UPDATES_STORAGE_KEY), null)

  storage.setItem(getUpdatesStorageKey('tenant-1'), '{invalid json')
  assert.equal(readStoredUpdates('tenant-1'), undefined)
})

test('parseUploadProgressEvent accepts firmware upload progress events and ignores others', () => {
  const progress = parseUploadProgressEvent({
    type: 'plugin.event',
    pluginName: 'firmware-updates',
    event: {
      kind: 'upload-progress',
      printerId: 'printer-1',
      status: 'uploading',
      progress: 42,
      message: 'Uploading firmware',
      firmwareFilename: 'offline-ota.zip',
      firmwareVersion: '01.10.00.00'
    }
  })

  assert.deepEqual(progress, {
    printerId: 'printer-1',
    status: 'uploading',
    progress: 42,
    message: 'Uploading firmware',
    error: null,
    firmwareFilename: 'offline-ota.zip',
    firmwareVersion: '01.10.00.00'
  })
  assert.equal(parseUploadProgressEvent({ type: 'printer.status' }), null)
  assert.equal(parseUploadProgressEvent({ type: 'plugin.event', pluginName: 'other', event: { kind: 'upload-progress' } }), null)
})

test('parseFirmwareStatusEvent accepts printer status events and ignores others', () => {
  const printerStatus = printerStatusSchema.parse({
    printerId: 'printer-1',
    online: true,
    stage: 'idle',
    subStage: null,
    jobId: null,
    filamentChange: {
      currentStepIndex: null,
      currentStepLabel: null,
      steps: []
    },
    progressPercent: null,
    currentLayer: null,
    totalLayers: null,
    remainingMinutes: null,
    jobName: null,
    lastJobName: null,
    gcodeFile: null,
    bedTemp: null,
    bedTarget: null,
    nozzleTemp: null,
    nozzleTarget: null,
    nozzles: [],
    chamberTemp: null,
    chamberTarget: null,
    fanGearSpeed: null,
    partFanPercent: null,
    auxFanPercent: null,
    chamberFanPercent: null,
    wifiSignalDbm: null,
    ipAddress: null,
    doorOpen: null,
    ductMode: null,
    ductAvailableModes: [],
    lightModes: {
      chamber: null,
      heatbed: null,
      work: null
    },
    lightCapabilities: {
      chamber: false,
      heatbed: false,
      work: false
    },
    chamberLightOffRequiresConfirm: false,
    lightOn: null,
    speedLevel: null,
    commandTransport: {
      mqttBedTemperature: false,
      mqttAxisControl: false,
      mqttHoming: false,
      newFanControl: false
    },
    printOptions: {
      aiMonitoring: { supported: false, enabled: null, sensitivity: null },
      spaghettiDetection: { supported: false, enabled: null, sensitivity: null },
      purgeChutePileupDetection: { supported: false, enabled: null, sensitivity: null },
      nozzleClumpingDetection: { supported: false, enabled: null, sensitivity: null },
      airPrintingDetection: { supported: false, enabled: null, sensitivity: null },
      firstLayerInspection: { supported: false, enabled: null },
      autoRecovery: { supported: false, enabled: null },
      promptSound: { supported: false, enabled: null },
      filamentTangleDetection: { supported: false, enabled: null }
    },
    deviceError: null,
    hmsErrors: [],
    amsSettings: {
      detectOnInsert: null,
      detectOnPowerup: null,
      remainEnabled: null,
      autoRefill: null,
      supportFilamentBackup: null
    },
    ams: [],
    externalSpools: [],
    firmwareVersion: '01.10.00.00',
    sdCardPresent: true,
    observedAt: new Date(0).toISOString()
  })

  const status = parseFirmwareStatusEvent({
    type: 'printer.status',
    status: printerStatus
  })

  assert.deepEqual(status, {
    printerId: 'printer-1',
    online: true,
    firmwareVersion: '01.10.00.00',
    sdCardPresent: true
  })
  assert.equal(parseFirmwareStatusEvent({ type: 'plugin.event' }), null)
})

test('shouldInvalidateFirmwareUpdates only reacts to relevant printer status changes', () => {
  const previous: FirmwareStatusSnapshot = {
    printerId: 'printer-1',
    online: true,
    firmwareVersion: '01.09.00.00',
    sdCardPresent: true
  }

  assert.equal(shouldInvalidateFirmwareUpdates(undefined, previous), true)
  assert.equal(shouldInvalidateFirmwareUpdates(previous, previous), false)
  assert.equal(shouldInvalidateFirmwareUpdates(previous, { ...previous, printerId: 'printer-2' }), true)
  assert.equal(shouldInvalidateFirmwareUpdates(previous, { ...previous, firmwareVersion: '01.10.00.00' }), true)
  assert.equal(shouldInvalidateFirmwareUpdates(previous, { ...previous, sdCardPresent: false }), true)
  assert.equal(shouldInvalidateFirmwareUpdates(previous, { ...previous, online: false }), true)
})

test('version selection helpers prefer the latest installable version and expose release notes', () => {
  const installable = getInstallableVersions(sampleUpdate)

  assert.deepEqual(installable.map((version) => version.version), ['01.10.00.00', '01.09.01.00'])
  assert.equal(getDefaultSelectedVersion(sampleUpdate, installable), '01.10.00.00')
  assert.equal(isInstallableVersionSelected(installable, '01.09.01.00'), true)
  assert.equal(isInstallableVersionSelected(installable, '01.08.02.00'), false)
  assert.equal(isDowngradeSelection(sampleUpdate, '01.09.01.00'), true)
  assert.equal(isDowngradeSelection(sampleUpdate, '01.10.00.00'), false)
  assert.equal(getSelectedReleaseNotes(sampleUpdate, '01.09.01.00'), '# Version 01.09.01.00')
})

test('version selection falls back to the first installable version when the latest lacks a file', () => {
  const update: UpdateReport = {
    ...sampleUpdate,
    latestVersion: '01.11.00.00',
    availableVersions: [
      {
        version: '01.11.00.00',
        fileAvailable: false,
        releaseNotes: null,
        releaseTime: '2026-05-01T00:00:00Z',
        prerequisite: null
      },
      ...sampleUpdate.availableVersions
    ]
  }

  const installable = getInstallableVersions(update)
  assert.equal(getDefaultSelectedVersion(update, installable), '01.10.00.00')
})

test('module firmware sorts AMS units first and labels them 1-based', () => {
  const ordered = getModuleFirmware(sampleUpdate)
  assert.deepEqual(ordered.map((module) => module.name), ['ams/0', 'mc'])
  assert.equal(formatModuleLabel(ordered[0]!), 'AMS 1')
  assert.equal(formatModuleLabel(ordered[1]!), 'mc')
  assert.equal(formatModuleLabel({ name: 'ams/1', version: '0', hardwareVersion: null, isAms: true }), 'AMS 2')
  assert.deepEqual(getModuleFirmware(undefined), [])
})

test('chip and polling helpers reflect upload lifecycle and pending install state', () => {
  const uploading: UploadProgress = {
    printerId: 'printer-1',
    status: 'uploading',
    progress: 42,
    message: 'Uploading',
    error: null,
    firmwareFilename: 'offline-ota.zip',
    firmwareVersion: '01.10.00.00'
  }
  const complete: UploadProgress = {
    ...uploading,
    status: 'complete',
    progress: 100,
    message: 'Ready to flash'
  }

  assert.equal(isActiveUploadStatus(uploading.status), true)
  assert.equal(shouldPollUploadProgress(uploading), true)
  assert.equal(shouldPollUploadProgress(complete), false)
  assert.equal(firmwareStillPendingInstall(sampleUpdate, complete), true)
  assert.equal(isUploadedVersionLatest(sampleUpdate, complete), true)
  assert.equal(shouldShowFirmwareUpdateChip(sampleUpdate, undefined), true)
  assert.equal(shouldShowFirmwareUpdateChip({ ...sampleUpdate, updateAvailable: false }, complete), false)
  assert.equal(shouldShowFirmwareUpdateChip({ ...sampleUpdate, updateAvailable: false }, { ...complete, status: 'idle' }), false)
  assert.equal(shouldShowFirmwareUpdateChip(undefined, { ...complete, status: 'idle' }), false)
})

test('chip label and color helpers map each upload status to the intended UI copy', () => {
  assert.equal(formatFirmwareChipLabel(sampleUpdate, undefined), 'Update')
  assert.equal(formatFirmwareChipLabel({ ...sampleUpdate, updateAvailable: false }, undefined), 'Firmware')
  assert.equal(formatFirmwareChipLabel(sampleUpdate, {
    printerId: 'printer-1',
    status: 'preparing',
    progress: 0,
    message: '',
    error: null,
    firmwareFilename: null,
    firmwareVersion: '01.10.00.00'
  }), 'Preparing update')
  assert.equal(formatFirmwareChipLabel(sampleUpdate, {
    printerId: 'printer-1',
    status: 'downloading',
    progress: 5,
    message: '',
    error: null,
    firmwareFilename: null,
    firmwareVersion: '01.10.00.00'
  }), 'Downloading 5%')
  assert.equal(formatFirmwareChipLabel(sampleUpdate, {
    printerId: 'printer-1',
    status: 'uploading',
    progress: 8,
    message: '',
    error: null,
    firmwareFilename: null,
    firmwareVersion: '01.10.00.00'
  }), 'Uploading 8%')
  assert.equal(formatFirmwareChipLabel(sampleUpdate, {
    printerId: 'printer-1',
    status: 'complete',
    progress: 100,
    message: '',
    error: null,
    firmwareFilename: null,
    firmwareVersion: '01.10.00.00'
  }), 'Flash 01.10.00.00')
  assert.equal(formatFirmwareChipLabel(sampleUpdate, {
    printerId: 'printer-1',
    status: 'cancelled',
    progress: 0,
    message: '',
    error: null,
    firmwareFilename: null,
    firmwareVersion: null
  }), 'Cancelled')
  assert.equal(formatFirmwareChipLabel(sampleUpdate, {
    printerId: 'printer-1',
    status: 'error',
    progress: 0,
    message: '',
    error: 'Boom',
    firmwareFilename: null,
    firmwareVersion: null
  }), 'Upload failed')

  assert.equal(firmwareChipColor(sampleUpdate, undefined), 'warning')
  assert.equal(firmwareChipColor({ ...sampleUpdate, updateAvailable: false }, undefined), 'neutral')
  assert.equal(firmwareChipColor(sampleUpdate, {
    printerId: 'printer-1',
    status: 'uploading',
    progress: 1,
    message: '',
    error: null,
    firmwareFilename: null,
    firmwareVersion: null
  }), 'primary')
  assert.equal(firmwareChipColor(sampleUpdate, {
    printerId: 'printer-1',
    status: 'complete',
    progress: 100,
    message: '',
    error: null,
    firmwareFilename: null,
    firmwareVersion: null
  }), 'success')
  assert.equal(firmwareChipColor(sampleUpdate, {
    printerId: 'printer-1',
    status: 'error',
    progress: 0,
    message: '',
    error: 'Boom',
    firmwareFilename: null,
    firmwareVersion: null
  }), 'danger')
})

test('isOfflineUpdateBlocked reflects the report offline floor flag', () => {
  assert.equal(isOfflineUpdateBlocked(undefined), false)
  assert.equal(isOfflineUpdateBlocked(sampleUpdate), false)
  assert.equal(
    isOfflineUpdateBlocked({ ...sampleUpdate, offlineUpdate: { minimumVersion: '01.07.00.00', belowMinimum: true } }),
    true
  )
})

test('getSelectedPrerequisite returns the stepping-stone hop attached to the selected version', () => {
  const update: UpdateReport = {
    ...sampleUpdate,
    availableVersions: [
      {
        version: '01.10.00.00',
        fileAvailable: true,
        releaseNotes: null,
        releaseTime: null,
        prerequisite: { requiredVersion: '01.09.01.00', label: 'Bridge Firmware' }
      },
      { version: '01.09.01.00', fileAvailable: true, releaseNotes: null, releaseTime: null, prerequisite: null }
    ]
  }

  assert.deepEqual(getSelectedPrerequisite(update, '01.10.00.00'), {
    requiredVersion: '01.09.01.00',
    label: 'Bridge Firmware'
  })
  assert.equal(getSelectedPrerequisite(update, '01.09.01.00'), null)
  assert.equal(getSelectedPrerequisite(update, null), null)
  assert.equal(getSelectedPrerequisite(undefined, '01.10.00.00'), null)
})

function createMockStorage() {
  const values = new Map<string, string>()
  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    }
  }
}

function setMockWindow(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: storage
    }
  })
}

function deleteMockWindow(): void {
  delete (globalThis as { window?: unknown }).window
}