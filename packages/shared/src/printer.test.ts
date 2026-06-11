import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getAmsLoadFilamentAvailability,
  getAmsUnloadFilamentAvailability,
  getCheckAssistantAvailability,
  getConfirmAmsFilamentExtrudedAvailability,
  getExternalSpoolLoadAvailability,
  getExternalSpoolUnloadAvailability,
  getIgnoreHmsErrorAvailability,
  getJumpToLiveViewAvailability,
  getLoadFilamentAvailability,
  getPauseAvailability,
  getPausedPrinterActions,
  getPrinterRecoveryActions,
  getRetryAmsFilamentChangeAvailability,
  isPausedFilamentRunoutWarning,
  canUseExtruderControl,
  canUseMotionControl,
  canUsePrintSpeedControl,
  getPrinterCalibrationCapabilities,
  getPrinterChamberTemperatureMax,
  getPrinterDisplayCapabilities,
  getPrinterControlCapabilities,
  getPrinterPrintStartOptions,
  getPrinterPrintOptionCapabilities,
  getResumeAvailability,
  getStopAvailability,
  printerInputSchema,
  supportsPrinterChamberTemperatureDisplay,
  supportsPrinterAirductMode,
  supportsPrinterCamera,
  supportsPrinterDoorSensor,
  supportsPrinterSecondaryChamberLight,
  usesCoreXyMotionSystem
} from './printer.js'

test('printer support helpers expose model-specific capabilities', () => {
  assert.deepEqual(getPrinterDisplayCapabilities('P1S'), {
    camera: true,
    chamberTemperature: false,
    doorState: false,
    airductMode: false
  })
  assert.deepEqual(getPrinterDisplayCapabilities('H2D'), {
    camera: true,
    chamberTemperature: true,
    doorState: true,
    airductMode: true
  })
  assert.equal(supportsPrinterCamera('X1'), true)
  assert.equal(getPrinterChamberTemperatureMax('X1E'), 60)
  assert.equal(getPrinterChamberTemperatureMax('H2S'), 65)
  assert.equal(supportsPrinterCamera('P2S'), true)
  assert.equal(supportsPrinterDoorSensor('P1S'), false)
  assert.equal(supportsPrinterChamberTemperatureDisplay('P1S'), false)
  assert.equal(supportsPrinterChamberTemperatureDisplay('X1C'), true)
  assert.equal(supportsPrinterDoorSensor('X1'), true)
  assert.equal(supportsPrinterDoorSensor('H2S'), true)
  assert.equal(supportsPrinterAirductMode('P2S'), true)
  assert.equal(supportsPrinterAirductMode('A1'), false)
  assert.equal(supportsPrinterCamera('A2L'), true)
  assert.equal(supportsPrinterDoorSensor('A2L'), false)
  assert.equal(supportsPrinterChamberTemperatureDisplay('A2L'), false)
  assert.equal(supportsPrinterAirductMode('A2L'), false)
  assert.equal(usesCoreXyMotionSystem('A2L'), false)
  assert.equal(supportsPrinterSecondaryChamberLight('H2D'), true)
  assert.equal(supportsPrinterSecondaryChamberLight('X1C'), false)
  assert.equal(usesCoreXyMotionSystem('X1'), true)
  assert.equal(usesCoreXyMotionSystem('P1S'), true)
  assert.equal(usesCoreXyMotionSystem('A1mini'), false)
})

test('printer capability helpers reflect model-specific feature sets', () => {
  assert.deepEqual(getPrinterCalibrationCapabilities('P2S'), {
    xcam: false,
    bedLeveling: true,
    vibration: true,
    motorNoise: true,
    nozzleOffset: true,
    highTempHeatbed: true,
    nozzleClumping: true
  })
  assert.deepEqual(getPrinterCalibrationCapabilities('H2DPRO'), {
    xcam: false,
    bedLeveling: true,
    vibration: true,
    motorNoise: true,
    nozzleOffset: true,
    highTempHeatbed: true,
    nozzleClumping: true
  })
  assert.equal(getPrinterControlCapabilities('H2S').chamberTemperature, true)
  assert.equal(getPrinterControlCapabilities('A1mini').dualNozzles, false)
  assert.equal(getPrinterPrintOptionCapabilities('A1').flowCalibration, true)
  assert.equal(getPrinterPrintOptionCapabilities('A1').flowCalibrationAuto, false)
  assert.equal(getPrinterPrintOptionCapabilities('H2S').bedLevelAuto, true)
  assert.equal(getPrinterPrintOptionCapabilities('H2S').flowCalibrationAuto, true)
  assert.equal(getPrinterPrintOptionCapabilities('X2D').firstLayerInspection, false)
  assert.equal(getPrinterPrintOptionCapabilities('H2S').filamentDynamicsCalibration, false)
  assert.equal(getPrinterPrintOptionCapabilities('H2DPRO').filamentDynamicsCalibration, false)
  assert.equal(getPrinterPrintOptionCapabilities('H2DPRO').nozzleOffsetCalibration, true)
  assert.equal(getPrinterPrintOptionCapabilities('X1C').firstLayerInspection, true)
  assert.equal(getPrinterPrintOptionCapabilities('P1P').timelapse, true)
  assert.deepEqual(getPrinterPrintStartOptions('X1C', {
    printOptions: {
      aiMonitoring: { supported: false, enabled: null, sensitivity: null },
      spaghettiDetection: { supported: false, enabled: null, sensitivity: null },
      purgeChutePileupDetection: { supported: false, enabled: null, sensitivity: null },
      nozzleClumpingDetection: { supported: false, enabled: null, sensitivity: null },
      airPrintingDetection: { supported: false, enabled: null, sensitivity: null },
      firstLayerInspection: { supported: true, enabled: false },
      autoRecovery: { supported: false, enabled: null },
      promptSound: { supported: false, enabled: null },
      filamentTangleDetection: { supported: false, enabled: null }
    }
  }).firstLayerInspection, {
    supported: true,
    current: false
  })
  assert.equal(getPrinterPrintOptionCapabilities('X2D', {
    printOptions: {
      aiMonitoring: { supported: false, enabled: null, sensitivity: null },
      spaghettiDetection: { supported: false, enabled: null, sensitivity: null },
      purgeChutePileupDetection: { supported: false, enabled: null, sensitivity: null },
      nozzleClumpingDetection: { supported: false, enabled: null, sensitivity: null },
      airPrintingDetection: { supported: false, enabled: null, sensitivity: null },
      firstLayerInspection: { supported: true, enabled: true },
      autoRecovery: { supported: false, enabled: null },
      promptSound: { supported: false, enabled: null },
      filamentTangleDetection: { supported: false, enabled: null }
    }
  }).firstLayerInspection, true)
})

test('runtime control helpers gate actions based on printer state', () => {
  assert.equal(canUsePrintSpeedControl({ online: true, stage: 'printing' }), true)
  assert.equal(canUsePrintSpeedControl({ online: true, stage: 'idle' }), false)
  assert.equal(canUseMotionControl({ online: true, stage: 'finished' }), true)
  assert.equal(canUseMotionControl({ online: true, stage: 'printing' }), false)
  assert.equal(
    canUseExtruderControl({
      online: true,
      stage: 'idle',
      nozzleTemp: 180,
      nozzles: [{ extruderId: 0, diameter: null, typeCode: null, material: null, flow: null, currentTemp: 180, targetTemp: null }]
    }),
    true
  )
  assert.equal(
    canUseExtruderControl({
      online: true,
      stage: 'idle',
      nozzleTemp: 150,
      nozzles: [{ extruderId: 0, diameter: null, typeCode: null, material: null, flow: null, currentTemp: 150, targetTemp: null }]
    }),
    false
  )
})

test('shared printer action availability exposes command precondition reasons', () => {
  assert.deepEqual(getPauseAvailability({ online: false, stage: 'printing' }), {
    allowed: false,
    reason: 'Pause is only available while the printer is connected'
  })
  assert.deepEqual(getResumeAvailability({
    online: true,
    stage: 'paused',
    subStage: null,
    jobId: 'job-1',
    deviceError: null,
    hmsErrors: [{ code: '03008012', message: 'Jam' }],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getResumeAvailability({
    online: true,
    stage: 'paused',
    subStage: null,
    jobId: 'job-1',
    deviceError: { code: '0C008043', message: 'Clumping' },
    hmsErrors: [],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getResumeAvailability({
    online: true,
    stage: 'paused',
    subStage: null,
    jobId: 'job-1',
    deviceError: null,
    hmsErrors: [],
    filamentChange: { currentStepIndex: 1, currentStepLabel: 'Heat the nozzle', steps: ['Heat the nozzle'] }
  }), {
    allowed: false,
    reason: 'Current extruder is busy changing filament'
  })
  assert.deepEqual(getResumeAvailability({
    online: true,
    stage: 'paused',
    subStage: '4',
    jobId: null,
    deviceError: { code: '07008011', message: 'AMS filament ran out. Please insert a new filament into the same AMS slot.' },
    hmsErrors: [{ code: '0700220000020001', message: 'AMS A Slot 3 filament has run out. Please insert a new filament.' }],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getStopAvailability({ online: true, stage: 'idle' }), {
    allowed: false,
    reason: 'Stop is only available while a print is active'
  })
  assert.deepEqual(getIgnoreHmsErrorAvailability({
    online: true,
    stage: 'paused',
    subStage: null,
    jobId: 'job-1',
    deviceError: { code: '07008011', message: 'Build plate mismatch' },
    hmsErrors: [],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getIgnoreHmsErrorAvailability({
    online: true,
    stage: 'paused',
    subStage: '6',
    jobId: 'job-1',
    deviceError: { code: '07008021', message: 'Filament ran out' },
    hmsErrors: [],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), {
    allowed: false,
    reason: 'Continue is not available while the printer is paused on filament runout'
  })
  assert.deepEqual(getIgnoreHmsErrorAvailability({
    online: true,
    stage: 'paused',
    subStage: '4',
    jobId: null,
    deviceError: { code: '07008006', message: 'Unable to feed filament into the extruder.' },
    hmsErrors: [{ code: '0700220000020006', message: 'AMS A has detected a breakage of the PTFE tube during filament loading.' }],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), {
    allowed: false,
    reason: 'Continue is only available when the printer reports a resumable warning id'
  })
  assert.deepEqual(getIgnoreHmsErrorAvailability({
    online: true,
    stage: 'paused',
    subStage: '4',
    jobId: null,
    deviceError: { code: '07008011', message: 'AMS filament ran out. Please insert a new filament into the same AMS slot.' },
    hmsErrors: [{ code: '0700220000020001', message: 'AMS A Slot 3 filament has run out. Please insert a new filament.' }],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), {
    allowed: false,
    reason: 'Continue is not available while the printer is paused on filament runout'
  })
  assert.deepEqual(getRetryAmsFilamentChangeAvailability({
    online: true,
    stage: 'paused',
    filamentChange: {
      currentStepIndex: 2,
      currentStepLabel: 'Confirm extruded',
      steps: ['Wait for AMS cooling', 'Switch track at Filament Track Switch', 'Confirm extruded']
    }
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getConfirmAmsFilamentExtrudedAvailability({
    online: true,
    stage: 'paused',
    filamentChange: {
      currentStepIndex: 2,
      currentStepLabel: 'Confirm extruded',
      steps: ['Wait for AMS cooling', 'Switch track at Filament Track Switch', 'Confirm extruded']
    }
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getPausedPrinterActions({
    online: true,
    stage: 'paused',
    subStage: '6',
    deviceError: { code: '07008021', message: 'Filament ran out' },
    hmsErrors: [],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), [{ id: 'resume', label: 'Resume' }])
  assert.deepEqual(getPausedPrinterActions({
    online: true,
    stage: 'paused',
    subStage: null,
    jobId: 'job-1',
    deviceError: { code: '07008011', message: 'Build plate mismatch' },
    hmsErrors: [],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] }
  }), [
    { id: 'resume', label: 'Resume' },
    { id: 'ignoreHmsError', label: 'Continue' }
  ])
  assert.deepEqual(getPausedPrinterActions({
    online: true,
    stage: 'paused',
    subStage: null,
    deviceError: { code: '07008021', message: 'Filament ran out' },
    hmsErrors: [],
    filamentChange: {
      currentStepIndex: 2,
      currentStepLabel: 'Confirm extruded',
      steps: ['Wait for AMS cooling', 'Switch track at Filament Track Switch', 'Confirm extruded']
    }
  }), [
    { id: 'retryAmsFilamentChange', label: 'Retry' },
    { id: 'confirmAmsFilamentExtruded', label: 'Continue' }
  ])
  assert.deepEqual(getLoadFilamentAvailability({
    online: true,
    stage: 'paused',
    subStage: '6',
    ams: [{
      unitId: 0,
      nozzleId: 0,
      supportDrying: false,
      dryTimeRemainingMinutes: null,
      dryingActive: false,
      dryFilament: null,
      dryTemperature: null,
      dryDurationHours: null,
      humidityPercent: null,
      humidityLevel: null,
      temperature: null,
      slots: [{
        slot: 1,
        trayName: null,
        filamentType: 'PLA',
        color: null,
        colors: [],
        remainPercent: null,
        active: false,
        isReading: false,
        trayInfoIdx: '',
        caliIdx: null,
        k: null,
        trayUuid: null
      }]
    }],
    externalSpools: []
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getCheckAssistantAvailability({
    online: true,
    stage: 'paused',
    deviceError: { code: '07008011', message: 'Build plate mismatch' },
    hmsErrors: []
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getJumpToLiveViewAvailability({
    online: true,
    stage: 'failed',
    deviceError: null,
    hmsErrors: [{ code: '03008012', message: 'Jam' }]
  }), {
    allowed: true,
    reason: null
  })
  assert.deepEqual(getPrinterRecoveryActions({
    online: true,
    stage: 'paused',
    subStage: '6',
    jobId: 'job-1',
    deviceError: { code: '07008021', message: 'Filament ran out' },
    hmsErrors: [],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] },
    ams: [{
      unitId: 0,
      nozzleId: 0,
      supportDrying: false,
      dryTimeRemainingMinutes: null,
      dryingActive: false,
      dryFilament: null,
      dryTemperature: null,
      dryDurationHours: null,
      humidityPercent: null,
      humidityLevel: null,
      temperature: null,
      slots: [{
        slot: 1,
        trayName: null,
        filamentType: 'PLA',
        color: null,
        colors: [],
        remainPercent: null,
        active: false,
        isReading: false,
        trayInfoIdx: '',
        caliIdx: null,
        k: null,
        trayUuid: null
      }]
    }],
    externalSpools: []
  }), [
    { id: 'resume', label: 'Resume' },
    { id: 'loadFilament', label: 'Load filament' },
    { id: 'checkAssistant', label: 'Check assistant' },
    { id: 'jumpToLiveView', label: 'Live view' }
  ])
  assert.deepEqual(getPrinterRecoveryActions({
    online: true,
    stage: 'paused',
    subStage: '4',
    jobId: null,
    deviceError: { code: '07008011', message: 'AMS filament ran out. Please insert a new filament into the same AMS slot.' },
    hmsErrors: [{ code: '0700220000020001', message: 'AMS A Slot 3 filament has run out. Please insert a new filament.' }],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] },
    ams: [],
    externalSpools: []
  }), [
    { id: 'resume', label: 'Resume' },
    { id: 'checkAssistant', label: 'Check assistant' },
    { id: 'jumpToLiveView', label: 'Live view' }
  ])
  assert.equal(isPausedFilamentRunoutWarning({
    stage: 'paused',
    subStage: '4',
    deviceError: { code: '07008011', message: 'AMS filament ran out. Please insert a new filament into the same AMS slot.' },
    hmsErrors: [{ code: '0700220000020001', message: 'AMS A Slot 3 filament has run out. Please insert a new filament.' }]
  }), true)
})

test('shared filament action availability validates AMS and external spool actions', () => {
  const idleSlot = {
    slot: 1,
    trayName: null,
    filamentType: 'PLA',
    color: null,
    colors: [],
    remainPercent: null,
    active: false,
    isReading: false,
    trayInfoIdx: '',
    caliIdx: null,
    k: null,
    trayUuid: null
  }
  const idleExternalSpool = {
    amsId: 254 as const,
    nozzleId: 0,
    trayName: null,
    filamentType: 'PETG',
    color: null,
    colors: [],
    remainPercent: null,
    active: false,
    trayInfoIdx: '',
    caliIdx: null,
    k: null,
    trayUuid: null
  }
  const idleAmsUnit = {
    unitId: 0,
    nozzleId: 0,
    supportDrying: false,
    dryTimeRemainingMinutes: null,
    dryingActive: false,
    dryFilament: null,
    dryTemperature: null,
    dryDurationHours: null,
    humidityPercent: null,
    humidityLevel: null,
    temperature: null,
    slots: [idleSlot]
  }
  const idleStatus: NonNullable<Parameters<typeof getAmsLoadFilamentAvailability>[0]> = {
    online: true,
    stage: 'idle' as const,
    subStage: null,
    deviceError: null,
    hmsErrors: [],
    filamentChange: { currentStepIndex: null, currentStepLabel: null, steps: [] },
    ams: [idleAmsUnit],
    externalSpools: [idleExternalSpool]
  }

  assert.deepEqual(getAmsLoadFilamentAvailability(idleStatus, 0, 1), { allowed: true, reason: null })
  assert.deepEqual(getAmsUnloadFilamentAvailability(idleStatus, 0, 1), { allowed: true, reason: null })
  assert.deepEqual(getExternalSpoolLoadAvailability(idleStatus, 254), { allowed: true, reason: null })
  assert.deepEqual(getExternalSpoolUnloadAvailability(idleStatus, 254), { allowed: true, reason: null })

  assert.deepEqual(getAmsLoadFilamentAvailability({
    ...idleStatus,
    ams: [{ ...idleAmsUnit, slots: [{ ...idleSlot, filamentType: null, trayInfoIdx: '' }] }]
  }, 0, 1), {
    allowed: false,
    reason: 'Filament type is unknown. Set the slot filament details before loading.'
  })

  assert.deepEqual(getExternalSpoolLoadAvailability({
    ...idleStatus,
    externalSpools: [{ ...idleExternalSpool, active: true }]
  }, 254), {
    allowed: false,
    reason: 'Selected filament source is already loaded'
  })

  assert.deepEqual(getAmsLoadFilamentAvailability({
    ...idleStatus,
    stage: 'paused',
    subStage: '6',
    filamentChange: { currentStepIndex: 1, currentStepLabel: 'Heating nozzle', steps: ['Heating nozzle'] }
  }, 0, 1), {
    allowed: true,
    reason: null
  })
})

test('printer input accepts mixed nozzle sizes for dual-nozzle models', () => {
  const parsed = printerInputSchema.safeParse({
    name: 'Dual nozzle test',
    host: 'demo.local',
    serial: 'SERIAL-1',
    accessCode: 'secret',
    model: 'H2D',
    currentPlateType: null,
    currentNozzleDiameters: [
      { extruderId: 0, diameter: '0.4' },
      { extruderId: 1, diameter: '0.6' }
    ]
  })

  assert.equal(parsed.success, true)
})