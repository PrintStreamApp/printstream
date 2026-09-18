/**
 * X1 Micro Lidar protocol: start and read only, never extrusion_cali_set/sel.
 * Mirrors Studio's CalibUtils::calib_PA and DevCalib result parser. Confidence
 * zero means success (it is an error code, not a confidence percentage).
 */
import { z } from 'zod'
import { automaticPaSetupSchema, type CalibrationParameters } from '@printstream/shared'
import { badRequest } from '../../lib/http-error.js'

export type AutomaticPaSetup = NonNullable<Extract<CalibrationParameters, { kind: 'pressureAdvance' }>['automaticSetup']>

const BED_KEYS: Record<string, string> = {
  'Cool Plate': 'cool_plate_temp',
  'Engineering Plate': 'eng_plate_temp',
  'High Temp Plate': 'hot_plate_temp',
  'Smooth PEI Plate': 'hot_plate_temp',
  'Textured PEI Plate': 'textured_plate_temp',
  'SuperTack Plate': 'supertack_plate_temp',
  'Cool Plate SuperTack': 'supertack_plate_temp'
}

/** Freeze the selected filament preset's temperatures; never invent a thermal default. */
export function automaticPaSetup(config: Record<string, string | string[]>, plate: string | null, trayIndex: number): AutomaticPaSetup {
  const scalar = (key: string): string => {
    const value = config[key]
    return (Array.isArray(value) ? value[0] : value) ?? ''
  }
  const bedKey = plate ? BED_KEYS[plate] : undefined
  if (!bedKey) throw badRequest('Choose a supported build plate for automatic calibration')
  const parsed = automaticPaSetupSchema.safeParse({
    nozzleTemperature: Number(scalar('nozzle_temperature')),
    bedTemperature: scalar(bedKey) === '' ? Number.NaN : Number(scalar(bedKey)),
    maxVolumetricSpeed: Number(scalar('filament_max_volumetric_speed')),
    filamentId: scalar('filament_id'),
    settingId: scalar('setting_id'),
    trayIndex
  })
  if (!parsed.success) throw badRequest('The filament preset does not provide valid automatic calibration settings')
  if (['GFU03', 'GFU04'].includes(parsed.data.filamentId)) {
    throw badRequest('Automatic Micro Lidar calibration does not support TPU 90A or TPU 85A')
  }
  return parsed.data
}

/** One explicitly selected tray; the printer authors and scans its own pattern. */
export function automaticPaStartFields(setup: AutomaticPaSetup, nozzleDiameter: string, amsId: number, slotId: number): Record<string, unknown> {
  return {
    mode: 0,
    nozzle_diameter: nozzleDiameter,
    filaments: [{
      tray_id: setup.trayIndex, ams_id: amsId, slot_id: slotId, extruder_id: 0,
      nozzle_id: `HS00-${nozzleDiameter}`, nozzle_diameter: nozzleDiameter,
      filament_id: setup.filamentId, setting_id: setup.settingId,
      nozzle_temp: setup.nozzleTemperature, bed_temp: setup.bedTemperature,
      max_volumetric_speed: String(setup.maxVolumetricSpeed)
    }]
  }
}

/** Read only a successful measurement for this run's exact tray, filament and nozzle. */
export function automaticPaResult(reply: Record<string, unknown>, setup: AutomaticPaSetup, nozzleDiameter: string): { k: number; n: number } | null {
  if (reply.result === 'fail') return null
  if (!Array.isArray(reply.filaments)) return null
  const matching = reply.filaments.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === 'object'
      && Number(entry.tray_id) === setup.trayIndex
      && entry.filament_id === setup.filamentId
      && Number(entry.nozzle_diameter ?? reply.nozzle_diameter) === Number(nozzleDiameter))
  )
  if (matching.length !== 1) return null
  const entry = matching[0]!
  if (entry.confidence !== 0) throw new Error('Micro Lidar could not measure this filament reliably. Try a manual tower.')
  const number = z.union([z.number(), z.string().trim().min(1)]).pipe(z.coerce.number().finite())
  const parsed = z.object({ k: number.pipe(z.number().min(0).max(2)), n: number }).safeParse({ k: entry.k_value, n: entry.n_coef })
  if (!parsed.success) throw new Error('The printer returned an invalid calibration measurement')
  return parsed.data
}
