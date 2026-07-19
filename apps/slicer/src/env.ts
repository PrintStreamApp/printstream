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
  // Debug aid: keep each job's work dir (the rewritten input 3MF and the materialized
  // profiles the CLI actually loaded) instead of deleting it when the response closes.
  // The rewritten input is the only place the effective `filament_map`/`filament_map_mode`
  // pair can be inspected, so a slice that fails inside BambuStudio's config handling is
  // otherwise undiagnosable. Off by default: the work dirs are large and never swept.
  SLICER_KEEP_WORK_DIR: booleanEnv(false),
  SLICER_TIMEOUT_MS: positiveIntEnv(30 * 60 * 1000),
  // Hard hang guard: if the CLI emits NO output at all for this long (before it reports
  // success), treat it as wedged, terminate it, and fail fast — instead of waiting out
  // SLICER_TIMEOUT_MS. BambuStudio is chatty, so a long total silence means a hang
  // (commonly the qemu-emulated "Exporting 3mf" step). Raise it if very large models on
  // slow hardware legitimately go silent for minutes.
  SLICER_STALL_TIMEOUT_MS: positiveIntEnv(5 * 60 * 1000),
  // Grace after BambuStudio reports "All done, Success" for its process to exit cleanly.
  // If it lingers past this (qemu teardown hang, leaving zombie Xvfb procs), the slicer
  // terminates it and treats the slice as done — the output is already fully written.
  SLICER_SUCCESS_EXIT_GRACE_MS: positiveIntEnv(20 * 1000)
})

export const env = envSchema.parse(process.env)
