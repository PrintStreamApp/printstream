/**
 * Browser storage keys owned by the calibration plugin (CONF-7, D-105; the registry is
 * `lib/browserStorageKeys.ts`).
 */
import { defineStorageKey } from '../../lib/browserStorageKeys'

const owner = 'plugin:calibration'

export const savedCalibrationDirectoryKey = defineStorageKey({ key: 'printstream.calibration.saved.directory', storage: 'local', kind: 'preference', owner })
export const savedCalibrationSortKey = defineStorageKey({ key: 'printstream.calibration.saved.sort', storage: 'local', kind: 'preference', owner })
export const savedCalibrationDirectionKey = defineStorageKey({ key: 'printstream.calibration.saved.direction', storage: 'local', kind: 'preference', owner })
