/**
 * The MACHINE (printer) settings catalog and its helpers.
 *
 * Thin by design: a machine preset has no project-embedded counterpart the way filament and process
 * presets do (a 3MF embeds those but only NAMES its printer), so there is no baseline-vs-embedded
 * diffing here — the resolved preset is the baseline. Everything else reuses the process catalog's
 * types and comparators, which is why the generated catalog is typed `ProcessSettingsCatalog`.
 *
 * Counterpart: `scripts/dev/generate-machine-settings.mjs`, which produces the generated catalog
 * from BambuStudio's TabPrinter layout + PrintConfig.cpp metadata.
 */
import { machineSettingsCatalog } from './generated/machine-settings.generated.js'
import { diffProcessConfig, type ProcessConfig } from './process-settings.js'

export { machineSettingsCatalog }

/**
 * Values that differ from the preset baseline, compared through the CATALOG option so a value
 * spelled differently but meaning the same (percent suffixes, numeric formatting) is not reported
 * as changed. Same rule as the process and filament diffs.
 */
export function diffMachineConfig(base: ProcessConfig, edited: ProcessConfig): ProcessConfig {
  return diffProcessConfig(base, edited, machineSettingsCatalog)
}
