/**
 * Printer controls dialog extracted from `pages/PrintersView.tsx`: a tabbed
 * modal (lights, speed, temperatures, fans, motion, extruder) that only
 * enables controls supported and safe for the printer's current state, and
 * emits `PrinterControlCommand`s to its caller.
 */
import { useState } from 'react'
import {
  Box, Button, ButtonGroup, Chip, Divider, Input, ModalClose, Sheet, Stack, Tab, TabList, Tabs, Typography
} from '@mui/joy'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import {
  PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C,
  canUseExtruderControl,
  canUseMotionControl,
  canUsePrintSpeedControl,
  getPrinterChamberTemperatureMax,
  getPrinterControlCapabilities,
  type Printer,
  type PrinterFanId,
  type PrinterStatus
} from '@printstream/shared'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { DialogSection } from '../DialogSection'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { LightbulbIcon } from './PrinterGlyphs'
import {
  formatNozzleHardwareSummary,
  formatPercentValue,
  formatStageLabel,
  formatTemperatureValue,
  isActiveLightMode,
  lightModeForControl,
  lightNodeLabel,
  formatLightMode,
  parseIntegerInput,
  printerNozzles,
  speedLabel,
  suggestedPercentInput,
  suggestedTemperatureInput,
  type PrinterControlCommand
} from '../../lib/printersViewHelpers'
import { CONTROLLABLE_LIGHT_NODES } from '../../lib/printerViewConstants'
import { type PrinterControlsDialogTab } from '../../lib/printerViewTypes'

export function PrinterControlsDialog({
  printer,
  status,
  capabilities,
  initialTab,
  submitting,
  onClose,
  onSubmit
}: {
  printer: Printer
  status: PrinterStatus
  capabilities: ReturnType<typeof getPrinterControlCapabilities>
  initialTab: PrinterControlsDialogTab
  submitting: boolean
  onClose: () => void
  onSubmit: (command: PrinterControlCommand) => void
}) {
  const nozzles = printerNozzles(status)
  const [temperatureInputs, setTemperatureInputs] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const nozzle of nozzles) {
      initial[`nozzle:${nozzle.extruderId}`] = suggestedTemperatureInput(nozzle.currentTemp, nozzle.targetTemp)
    }
    initial.bed = suggestedTemperatureInput(status.bedTemp, status.bedTarget)
    if (capabilities.chamberTemperature) {
      initial.chamber = suggestedTemperatureInput(status.chamberTemp, status.chamberTarget)
    }
    return initial
  })
  const [fanInputs, setFanInputs] = useState<Record<PrinterFanId, string>>(() => ({
    part: suggestedPercentInput(status.partFanPercent),
    aux: suggestedPercentInput(status.auxFanPercent),
    chamber: suggestedPercentInput(status.chamberFanPercent)
  }))
  const [activeTab, setActiveTab] = useState<PrinterControlsDialogTab>(initialTab)
  const [motionStep, setMotionStep] = useState<1 | 10>(10)
  const negativeMotionStep: -1 | -10 = motionStep === 10 ? -10 : -1
  const canAdjustPrintSpeed = canUsePrintSpeedControl(status)
  const canUseMotion = canUseMotionControl(status)
  const canUseAnyExtruderControl = nozzles.some((nozzle) => canUseExtruderControl(status, nozzle.extruderId))
  const chamberTempMax = getPrinterChamberTemperatureMax(printer.model)
  const stackedControlReadoutInset = 14
  const controllableLights = CONTROLLABLE_LIGHT_NODES.filter((node) => node === 'chamber' || status.lightCapabilities[node])
  const showWorkLight = status.lightCapabilities.work
  const hasFanControls = capabilities.partFan || capabilities.auxFan || capabilities.chamberFan
  const hasExtruderControls = capabilities.extruderControl

  const updateTemperatureInput = (key: string, value: string) => {
    setTemperatureInputs((current) => ({ ...current, [key]: value }))
  }

  const updateFanInput = (fan: PrinterFanId, value: string) => {
    setFanInputs((current) => ({ ...current, [fan]: value }))
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '96vw', sm: 720 }, maxWidth: '100%' }}>
        <ModalClose />
        <Typography level="h4">Controls for {printer.name}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          Only controls that are safe and supported for the current printer state are enabled.
        </Typography>

        <Tabs
          value={activeTab}
          onChange={(_event, value) => {
            if (typeof value === 'string') setActiveTab(value as PrinterControlsDialogTab)
          }}
          sx={{ minWidth: 0 }}
        >
          <TabList
            sx={{
              mb: 1,
              flexWrap: 'wrap',
              rowGap: 0.75,
              columnGap: 0.75
            }}
          >
            <Tab value="printer">Lights</Tab>
            <Tab value="speed">Speed</Tab>
            <Tab value="temperature">Temperatures</Tab>
            {hasFanControls && <Tab value="fans">Fans</Tab>}
            <Tab value="motion">Motion</Tab>
            {hasExtruderControls && <Tab value="extruder">Extruder</Tab>}
          </TabList>

          <ScrollableDialogBody>
            <Stack spacing={1.25}>
              {activeTab === 'printer' && (
                <DialogSection title="Lights" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1}>
                      {controllableLights.map((node) => {
                        const mode = lightModeForControl(status, node)
                        const lightOn = isActiveLightMode(mode)
                        return (
                          <Stack key={node} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography level="body-sm">{lightNodeLabel(node)}</Typography>
                              <Typography level="body-xs" textColor="text.tertiary">
                                {formatLightMode(mode)}
                              </Typography>
                            </Box>
                            <Button
                              size="sm"
                              variant={lightOn ? 'soft' : 'solid'}
                              color={lightOn ? 'warning' : 'neutral'}
                              startDecorator={<LightbulbIcon on={lightOn} />}
                              disabled={!status.online || submitting}
                              onClick={() => onSubmit({ type: 'light', node, on: !lightOn })}
                            >
                              {lightOn ? 'Turn off' : 'Turn on'}
                            </Button>
                          </Stack>
                        )
                      })}
                      {showWorkLight && (
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography level="body-sm">{lightNodeLabel('work')}</Typography>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {formatLightMode(status.lightModes.work)}
                            </Typography>
                          </Box>
                          <Chip size="sm" variant="soft" color="neutral">Read-only</Chip>
                        </Stack>
                      )}
                    </Stack>
                    {!status.online && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
                        Printer actions are only available while the printer is connected.
                      </Typography>
                    )}
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'speed' && (
                <DialogSection title="Print speed" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <ButtonGroup size="sm" orientation="vertical" aria-label="Print speed" sx={{ width: '100%', '& > *': { minWidth: 0 } }}>
                      {[1, 2, 3, 4].map((level) => (
                        <Button
                          key={level}
                          variant={status.speedLevel === level ? 'solid' : 'soft'}
                          color={status.speedLevel === level ? 'primary' : 'neutral'}
                          disabled={!canAdjustPrintSpeed || submitting}
                          onClick={() => onSubmit({ type: 'setPrintSpeed', level: level as 1 | 2 | 3 | 4 })}
                          sx={{ px: { xs: 1, sm: 1.5 } }}
                        >
                          {speedLabel(level)}
                        </Button>
                      ))}
                    </ButtonGroup>
                    {!canAdjustPrintSpeed && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
                        Print speed can only be changed while a print is active.
                      </Typography>
                    )}
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'temperature' && (
                <DialogSection title="Temperatures" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1}>
                      {nozzles.map((nozzle) => {
                const label = capabilities.dualNozzles
                  ? nozzle.extruderId === 0
                    ? 'Right nozzle'
                    : 'Left nozzle'
                  : 'Nozzle'
                const inputKey = `nozzle:${nozzle.extruderId}`
                const parsedTarget = parseIntegerInput(temperatureInputs[inputKey] ?? '', 0, 320)
                const hardwareSummary = formatNozzleHardwareSummary(nozzle)
                return (
                  <Stack key={inputKey} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                    <Box sx={{ minWidth: { sm: 150 }, pr: { xs: stackedControlReadoutInset, sm: 0 } }}>
                      <Stack
                        direction={{ xs: 'row', sm: 'column' }}
                        spacing={{ xs: 0.75, sm: 0.25 }}
                        alignItems={{ xs: 'baseline', sm: 'flex-start' }}
                        sx={{
                          minWidth: 0,
                          flexWrap: { xs: 'wrap', sm: 'nowrap' },
                          justifyContent: { xs: 'space-between', sm: 'flex-start' }
                        }}
                      >
                        <Typography level="body-sm">{label}</Typography>
                        {hardwareSummary && (
                          <Typography
                            level="body-xs"
                            textColor="text.tertiary"
                            sx={{ minWidth: 0, textAlign: { xs: 'right', sm: 'left' } }}
                          >
                            {hardwareSummary}
                          </Typography>
                        )}
                        <Typography
                          level="body-xs"
                          textColor="text.tertiary"
                          sx={{ minWidth: 0, flexBasis: { xs: '100%', sm: 'auto' }, textAlign: { xs: 'right', sm: 'left' } }}
                        >
                          Now {formatTemperatureValue(nozzle.currentTemp)} · Target {formatTemperatureValue(nozzle.targetTemp)}
                        </Typography>
                      </Stack>
                    </Box>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0, justifyContent: { sm: 'flex-end' } }}>
                      <Input
                        type="number"
                        value={temperatureInputs[inputKey] ?? ''}
                        onChange={(event) => updateTemperatureInput(inputKey, event.target.value)}
                        endDecorator="°C"
                        sx={{ flex: 1, minWidth: 0, maxWidth: { sm: 160 } }}
                      />
                      <Button
                        size="sm"
                        disabled={!status.online || parsedTarget == null || submitting}
                        onClick={() => parsedTarget != null && onSubmit({ type: 'setNozzleTemperature', extruderId: nozzle.extruderId, target: parsedTarget })}
                      >
                        Set
                      </Button>
                      <Button
                        size="sm"
                        variant="plain"
                        disabled={!status.online || submitting}
                        onClick={() => onSubmit({ type: 'setNozzleTemperature', extruderId: nozzle.extruderId, target: 0 })}
                      >
                        Off
                      </Button>
                    </Stack>
                  </Stack>
                        )
                      })}
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                <Box sx={{ minWidth: { sm: 150 }, pr: { xs: stackedControlReadoutInset, sm: 0 } }}>
                  <Stack
                    direction={{ xs: 'row', sm: 'column' }}
                    spacing={{ xs: 0.75, sm: 0.25 }}
                    alignItems={{ xs: 'baseline', sm: 'flex-start' }}
                    sx={{
                      minWidth: 0,
                      flexWrap: { xs: 'wrap', sm: 'nowrap' },
                      justifyContent: { xs: 'space-between', sm: 'flex-start' }
                    }}
                  >
                    <Typography level="body-sm">Bed</Typography>
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, textAlign: { xs: 'right', sm: 'left' } }}>
                      Now {formatTemperatureValue(status.bedTemp)} · Target {formatTemperatureValue(status.bedTarget)}
                    </Typography>
                  </Stack>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0, justifyContent: { sm: 'flex-end' } }}>
                  <Input
                    type="number"
                    value={temperatureInputs.bed ?? ''}
                    onChange={(event) => updateTemperatureInput('bed', event.target.value)}
                    endDecorator="°C"
                    sx={{ flex: 1, minWidth: 0, maxWidth: { sm: 160 } }}
                  />
                  <Button
                    size="sm"
                    disabled={!status.online || parseIntegerInput(temperatureInputs.bed ?? '', 0, 120) == null || submitting}
                    onClick={() => {
                      const parsedTarget = parseIntegerInput(temperatureInputs.bed ?? '', 0, 120)
                      if (parsedTarget != null) onSubmit({ type: 'setBedTemperature', target: parsedTarget })
                    }}
                  >
                    Set
                  </Button>
                  <Button
                    size="sm"
                    variant="plain"
                    disabled={!status.online || submitting}
                    onClick={() => onSubmit({ type: 'setBedTemperature', target: 0 })}
                  >
                    Off
                  </Button>
                </Stack>
                      </Stack>
                      {capabilities.chamberTemperature && (
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                  <Box sx={{ minWidth: { sm: 150 }, pr: { xs: stackedControlReadoutInset, sm: 0 } }}>
                    <Stack
                      direction={{ xs: 'row', sm: 'column' }}
                      spacing={{ xs: 0.75, sm: 0.25 }}
                      alignItems={{ xs: 'baseline', sm: 'flex-start' }}
                      sx={{
                        minWidth: 0,
                        flexWrap: { xs: 'wrap', sm: 'nowrap' },
                        justifyContent: { xs: 'space-between', sm: 'flex-start' }
                      }}
                    >
                      <Typography level="body-sm">Chamber</Typography>
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, textAlign: { xs: 'right', sm: 'left' } }}>
                        Now {formatTemperatureValue(status.chamberTemp)} · Target {formatTemperatureValue(status.chamberTarget)}
                      </Typography>
                    </Stack>
                  </Box>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0, justifyContent: { sm: 'flex-end' } }}>
                    <Input
                      type="number"
                      value={temperatureInputs.chamber ?? ''}
                      onChange={(event) => updateTemperatureInput('chamber', event.target.value)}
                      endDecorator="°C"
                      sx={{ flex: 1, minWidth: 0, maxWidth: { sm: 160 } }}
                    />
                    <Button
                      size="sm"
                      disabled={!status.online || parseIntegerInput(temperatureInputs.chamber ?? '', 0, chamberTempMax) == null || submitting}
                      onClick={() => {
                        const parsedTarget = parseIntegerInput(temperatureInputs.chamber ?? '', 0, chamberTempMax)
                        if (parsedTarget != null) onSubmit({ type: 'setChamberTemperature', target: parsedTarget })
                      }}
                    >
                      Set
                    </Button>
                    <Button
                      size="sm"
                      variant="plain"
                      disabled={!status.online || submitting}
                      onClick={() => onSubmit({ type: 'setChamberTemperature', target: 0 })}
                    >
                      Off
                    </Button>
                  </Stack>
                        </Stack>
                      )}
                      {!status.online && (
                        <Typography level="body-xs" textColor="text.tertiary">
                          Temperature controls are only available while the printer is connected.
                        </Typography>
                      )}
                    </Stack>
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'fans' && hasFanControls && (
                <DialogSection title="Fans" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1}>
                      {([
                { fan: 'part', label: 'Part fan', supported: capabilities.partFan, current: status.partFanPercent },
                { fan: 'aux', label: 'Aux fan', supported: capabilities.auxFan, current: status.auxFanPercent },
                { fan: 'chamber', label: 'Chamber fan', supported: capabilities.chamberFan, current: status.chamberFanPercent }
              ] as const)
                .filter((entry) => entry.supported)
                .map((entry) => {
                  const parsedPercent = parseIntegerInput(fanInputs[entry.fan], 0, 100)
                  return (
                    <Stack key={entry.fan} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                      <Box sx={{ minWidth: { sm: 150 }, pr: { xs: stackedControlReadoutInset, sm: 0 } }}>
                        <Stack
                          direction={{ xs: 'row', sm: 'column' }}
                          spacing={{ xs: 0.75, sm: 0.25 }}
                          alignItems={{ xs: 'baseline', sm: 'flex-start' }}
                          sx={{
                            minWidth: 0,
                            flexWrap: { xs: 'wrap', sm: 'nowrap' },
                            justifyContent: { xs: 'space-between', sm: 'flex-start' }
                          }}
                        >
                          <Typography level="body-sm">{entry.label}</Typography>
                          <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 0, textAlign: { xs: 'right', sm: 'left' } }}>
                            Current {formatPercentValue(entry.current)}
                          </Typography>
                        </Stack>
                      </Box>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0, justifyContent: { sm: 'flex-end' } }}>
                        <Input
                          type="number"
                          value={fanInputs[entry.fan]}
                          onChange={(event) => updateFanInput(entry.fan, event.target.value)}
                          endDecorator="%"
                          sx={{ flex: 1, minWidth: 0, maxWidth: { sm: 160 } }}
                        />
                        <Button
                          size="sm"
                          disabled={!status.online || parsedPercent == null || submitting}
                          onClick={() => parsedPercent != null && onSubmit({ type: 'setFanSpeed', fan: entry.fan, percent: parsedPercent })}
                        >
                          Set
                        </Button>
                        <Button
                          size="sm"
                          variant="plain"
                          disabled={!status.online || submitting}
                          onClick={() => onSubmit({ type: 'setFanSpeed', fan: entry.fan, percent: 0 })}
                        >
                          Off
                        </Button>
                      </Stack>
                    </Stack>
                  )
                })}
                      {!status.online && (
                        <Typography level="body-xs" textColor="text.tertiary">
                          Fan controls are only available while the printer is connected.
                        </Typography>
                      )}
                    </Stack>
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'motion' && (
                <DialogSection
                  title="Motion control"
                  description={`Current stage: ${formatStageLabel(status)}`}
                  wrapInSheet={false}
                >
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
                      <Box sx={{ flex: 1 }} />
                      <ButtonGroup size="sm">
                        {[1, 10].map((step) => (
                          <Button
                            key={step}
                            variant={motionStep === step ? 'solid' : 'soft'}
                            onClick={() => setMotionStep(step as 1 | 10)}
                          >
                            {step} mm
                          </Button>
                        ))}
                      </ButtonGroup>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="stretch" sx={{ minWidth: 0 }}>
              <Box
                sx={{
                  display: 'grid',
                  gap: 1,
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  flex: 1,
                  minWidth: 0,
                  flexShrink: 1
                }}
              >
                <Box />
                <Button
                  size="sm"
                  sx={{ minHeight: 64 }}
                  aria-label={`Move Y positive ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'Y', distanceMm: motionStep })}
                >
                  <ArrowUpwardRoundedIcon fontSize="small" />
                </Button>
                <Box />
                <Button
                  size="sm"
                  sx={{ minHeight: 64 }}
                  aria-label={`Move X negative ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'X', distanceMm: negativeMotionStep })}
                >
                  <ArrowBackRoundedIcon fontSize="small" />
                </Button>
                <Button size="sm" variant="soft" sx={{ minHeight: 64 }} disabled={!canUseMotion || submitting} onClick={() => onSubmit({ type: 'homeAxes' })}>Home</Button>
                <Button
                  size="sm"
                  sx={{ minHeight: 64 }}
                  aria-label={`Move X positive ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'X', distanceMm: motionStep })}
                >
                  <ArrowForwardRoundedIcon fontSize="small" />
                </Button>
                <Box />
                <Button
                  size="sm"
                  sx={{ minHeight: 64 }}
                  aria-label={`Move Y negative ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'Y', distanceMm: negativeMotionStep })}
                >
                  <ArrowDownwardRoundedIcon fontSize="small" />
                </Button>
                <Box />
              </Box>
              <Divider orientation="vertical" sx={{ alignSelf: 'stretch' }} />
              <Stack spacing={1} sx={{ flexShrink: 0, alignSelf: 'stretch', minWidth: 128 }}>
                <Button
                  size="sm"
                  sx={{ flex: 1, minHeight: 64, minWidth: 128 }}
                  aria-label={`Move the bed up ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'Z', distanceMm: negativeMotionStep })}
                >
                  <ArrowUpwardRoundedIcon fontSize="small" />
                </Button>
                <Button
                  size="sm"
                  sx={{ flex: 1, minHeight: 64, minWidth: 128 }}
                  aria-label={`Move the bed down ${motionStep} millimeters`}
                  disabled={!canUseMotion || submitting}
                  onClick={() => onSubmit({ type: 'moveAxis', axis: 'Z', distanceMm: motionStep })}
                >
                  <ArrowDownwardRoundedIcon fontSize="small" />
                </Button>
              </Stack>
                    </Stack>
                    {!canUseMotion && (
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
                        Motion control is only available while the printer is idle.
                      </Typography>
                    )}
                  </Sheet>
                </DialogSection>
              )}

              {activeTab === 'extruder' && hasExtruderControls && (
                <DialogSection title="Extruder control" wrapInSheet={false}>
                  <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
                    <Stack spacing={1}>
                      {nozzles.map((nozzle) => {
                  const label = capabilities.dualNozzles
                    ? nozzle.extruderId === 0
                      ? 'Right nozzle'
                      : 'Left nozzle'
                    : 'Nozzle'
                  const canControlThisExtruder = canUseExtruderControl(status, nozzle.extruderId)
                  return (
                    <Stack key={`extruder:${nozzle.extruderId}`} direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography level="body-sm">{label}</Typography>
                        <Typography level="body-xs" textColor="text.tertiary">
                          Current {formatTemperatureValue(nozzle.currentTemp)}
                        </Typography>
                      </Box>
                      <Stack spacing={1} sx={{ flexShrink: 0 }}>
                        <Button
                          size="sm"
                          variant="soft"
                          disabled={!canControlThisExtruder || submitting}
                          onClick={() => onSubmit({ type: 'extrudeFilament', extruderId: nozzle.extruderId, distanceMm: negativeMotionStep })}
                        >
                          Retract {motionStep} mm
                        </Button>
                        <Button
                          size="sm"
                          disabled={!canControlThisExtruder || submitting}
                          onClick={() => onSubmit({ type: 'extrudeFilament', extruderId: nozzle.extruderId, distanceMm: motionStep })}
                        >
                          Extrude {motionStep} mm
                        </Button>
                      </Stack>
                    </Stack>
                  )
                      })}
                      {!canUseAnyExtruderControl && (
                        <Typography level="body-xs" textColor="text.tertiary">
                          Extruder control requires an idle printer and a nozzle temperature of at least {PRINTER_EXTRUDER_CONTROL_MIN_TEMP_C}°C.
                        </Typography>
                      )}
                    </Stack>
                  </Sheet>
                </DialogSection>
              )}
            </Stack>
          </ScrollableDialogBody>
        </Tabs>

        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
