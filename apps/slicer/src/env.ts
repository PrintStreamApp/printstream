/**
 * Environment parsing for the standalone slicer runtime.
 */
import { z } from 'zod'

function optionalStringEnv() {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.string().optional())
}

function positiveIntEnv(defaultValue: number) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.coerce.number().int().positive().default(defaultValue))
}

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value === 'boolean') return value
    if (typeof value !== 'string') return value
    const normalized = value.trim().toLowerCase()
    if (!normalized) return undefined
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    return value
  }, z.boolean().default(defaultValue))
}

const envSchema = z.object({
  SLICER_PORT: positiveIntEnv(4010),
  SLICER_DEFAULT_TARGET_ID: optionalStringEnv(),
  SLICER_TARGETS_FILE: z.string().default('/opt/printstream-slicers/targets.json'),
  SLICER_CLI_PATH: optionalStringEnv(),
  SLICER_CLI_ARGS_TEMPLATE: z.string().default('--slice {plate} --debug 2 --outputdir {outputDir} --min-save --export-3mf {outputFileName} --export-json {input} {input}'),
  SLICER_SERVICE_TOKEN: optionalStringEnv(),
  SLICER_WORK_DIR: z.string().default('/tmp/printstream-slicer'),
  SLICER_BAMBUSTUDIO_HOME_DIR: z.string().default('/tmp/printstream-slicer/bambustudio-home'),
  SLICER_BAMBUSTUDIO_DATA_DIR: z.string().default('/tmp/printstream-slicer/bambustudio-data'),
  SLICER_BAMBUSTUDIO_PROFILE_DIR: z.string().default('/opt/bambustudio/squashfs-root/resources/profiles/BBL'),
  SLICER_ENABLE_PIPE_PROGRESS: booleanEnv(true),
  SLICER_TIMEOUT_MS: positiveIntEnv(30 * 60 * 1000),
  PATH: z.string().default('')
})

export const env = envSchema.parse(process.env)
