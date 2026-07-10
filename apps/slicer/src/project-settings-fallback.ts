/**
 * Ensure a to-be-sliced 3MF carries a structurally complete `Metadata/project_settings.config`.
 *
 * A "from scratch" project 3MF (PrintStream's calibration scaffolds and new-project saves, built
 * by `buildEditedThreeMf(null, …)`) carries the `Application: BambuStudio-…` marker so the CLI
 * takes its BBL-project path — which is required to slice per-plate and keep the injected
 * `custom_gcode_per_layer.xml` (without the marker the CLI logs "not support to slice plate N,
 * reset to 0" and drops the per-layer G-code). But that BBL-project loader dereferences the
 * project's embedded `project_settings.config`, and a scaffold 3MF has none — so the CLI
 * segfaults (SIGSEGV / exit 139) at load, before it reads the model.
 *
 * A hand-merge of the machine/process/filament presets does NOT satisfy the loader (it fills ~150
 * defaulted keys the presets omit). So we let BambuStudio itself produce a genuine merged config
 * via a fast `--export-settings` pass over the very `--load-settings`/`--load-filaments` the slice
 * will use, then embed that as the 3MF's `project_settings.config`. The slice's own
 * `--load-settings` still overrides these values (3mf-embedded settings are lowest priority), so
 * the embedded config only needs to be structurally complete — which a genuine export is.
 *
 * A scaffold save can embed a PARTIAL config (the editor's chosen filaments / plate type /
 * retargeted machine — see the API's `buildEditedThreeMf` + `retargetSavedProjectMachine`), which
 * is just as unsafe for the loader as no config. Those are detected by
 * {@link hasCompleteEmbeddedProjectSettings} (cross-domain sentinel keys) and repaired the same
 * way, with the partial values overlaid onto the genuine export so the user's choices
 * (`curr_bed_type`, filament colours, machine identity) still win. This matters MOST for a
 * project-preset slice (`project:process:…`), which loads no external profiles at all — the CLI
 * then reads the embedded settings bare and a partial config segfaults it deterministically at
 * load; the export args for that case are derived from the preset names the settings themselves
 * carry, resolved against the slicer's builtin catalog.
 *
 * A no-op when the 3MF already embeds a complete `project_settings.config` (every real
 * BambuStudio project), so normal slicing is untouched.
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import yazl from 'yazl'
import { type Entry } from 'yauzl'
import { sanitizeProfileFileName } from './profile-file-name.js'
import { openZip, readZipEntryBuffer, readZipEntryText } from './zip-io.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

/**
 * One sentinel key per settings domain. A genuine BambuStudio/OrcaSlicer project (or an
 * `--export-settings` merge) serializes its FULL config and always carries all three; the partial
 * configs our save path can embed (filament colours + plate type, optionally machine/process keys
 * from a retarget but never the full defaulted filament arrays) always miss at least one.
 */
const COMPLETE_SETTINGS_SENTINEL_KEYS = ['printable_area', 'layer_height', 'nozzle_temperature'] as const

/** The embedded `project_settings.config` as a parsed record, or null when absent/unreadable. */
async function readEmbeddedProjectSettings(inputPath: string): Promise<Record<string, unknown> | null> {
  const text = await readZipEntryText(inputPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (typeof text !== 'string' || text.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Whether the 3MF already embeds a `project_settings.config` (any real BambuStudio project does). */
export async function hasEmbeddedProjectSettings(inputPath: string): Promise<boolean> {
  const text = await readZipEntryText(inputPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  return typeof text === 'string' && text.trim().length > 0
}

/**
 * Whether the 3MF embeds a structurally COMPLETE `project_settings.config` — one safe for the
 * CLI's BBL-project loader (see the module header). Exposed for tests.
 */
export async function hasCompleteEmbeddedProjectSettings(inputPath: string): Promise<boolean> {
  const settings = await readEmbeddedProjectSettings(inputPath)
  return settings !== null && COMPLETE_SETTINGS_SENTINEL_KEYS.every((key) => settings[key] !== undefined)
}

function firstStringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim())
    return typeof first === 'string' ? first.trim() : null
  }
  return null
}

async function builtinProfilePathForName(profileDir: string, kind: 'machine' | 'process' | 'filament', name: string | null): Promise<string | null> {
  if (!name) return null
  const filePath = path.join(profileDir, `${kind}_full`, `${sanitizeProfileFileName(name)}.json`)
  return access(filePath).then(() => filePath, () => null)
}

/**
 * Build `--load-settings`/`--load-filaments` args for the settings export by resolving the
 * preset NAMES the embedded settings themselves carry (`printer_settings_id`,
 * `print_settings_id`, `filament_settings_id`) against the slicer's flattened builtin profile
 * catalog. This is what lets a PROJECT-PRESET slice — which deliberately loads no external
 * profiles (the embedded settings are the preset) — still synthesize a complete config when the
 * embedded settings turn out to be partial. Null when nothing resolves (e.g. custom presets),
 * in which case the caller slices as-is.
 */
async function buildExportArgsFromEmbeddedPresetNames(
  embedded: Record<string, unknown>,
  profileDir: string
): Promise<string[] | null> {
  const machinePath = await builtinProfilePathForName(profileDir, 'machine', firstStringValue(embedded.printer_settings_id))
  const processPath = await builtinProfilePathForName(profileDir, 'process', firstStringValue(embedded.print_settings_id))
  const filamentNames = Array.isArray(embedded.filament_settings_id)
    ? embedded.filament_settings_id.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
  const filamentPaths = (await Promise.all(
    filamentNames.map((name) => builtinProfilePathForName(profileDir, 'filament', name))
  )).filter((entry): entry is string => entry !== null)

  const settingsPaths = [machinePath, processPath].filter((entry): entry is string => entry !== null)
  // The export needs at least the machine or process preset to be meaningful; filaments alone
  // don't anchor a printable config.
  if (settingsPaths.length === 0) return null
  const args = ['--load-settings', settingsPaths.join(';')]
  if (filamentPaths.length > 0) args.push('--load-filaments', filamentPaths.join(';'))
  return args
}

/**
 * The export must cover the FILAMENT domain too: with no filament preset loaded, the exported
 * config omits the nullable per-filament override arrays (`filament_retraction_length`,
 * `filament_z_hop_types`, …) and the bare BBL-project loader still segfaults on the merge —
 * verified against the 2.7.1 CLI. When the args carry no `--load-filaments` (the project's
 * filament names didn't resolve, or the slice loads only a process), append Generic PLA: the
 * export is only a structural baseline, and the project's own values are overlaid on top.
 */
async function ensureFilamentCoverage(args: readonly string[], profileDir: string | null | undefined): Promise<readonly string[]> {
  if (args.includes('--load-filaments') || !profileDir) return args
  const fallback = await builtinProfilePathForName(profileDir, 'filament', 'Generic PLA')
  return fallback ? [...args, '--load-filaments', fallback] : args
}

/** Run the CLI with the given profile args + `--export-settings` and return the exported JSON, or null. */
async function exportMergedProjectSettings(input: {
  cliPath: string
  appDir: string | null
  profileArgs: readonly string[]
  workDir: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<string | null> {
  // `--export-settings` writes the fully merged `--load-settings`/`--load-filaments` config; it
  // needs no input model and does not slice, so it is fast. Absolute output path (no `--outputdir`).
  const settingsPath = path.join(input.workDir, `project-settings-${randomUUID()}.config`)
  const args = [...input.profileArgs, '--export-settings', settingsPath]
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(input.cliPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...input.env, SLICER_APPDIR: input.appDir ?? input.env.SLICER_APPDIR }
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    const onAbort = () => { try { child.kill('SIGKILL') } catch { /* already gone */ } }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => { input.signal?.removeEventListener('abort', onAbort); reject(error) })
    child.on('close', (code) => { input.signal?.removeEventListener('abort', onAbort); resolve(code) })
  })
  if (exitCode !== 0) {
    await rm(settingsPath, { force: true }).catch(() => undefined)
    return null
  }
  const content = await readFile(settingsPath, 'utf8').catch(() => null)
  await rm(settingsPath, { force: true }).catch(() => undefined)
  return content && content.trim().length > 0 ? content : null
}

/** Copy every entry of `inputPath` into `outputPath`, adding (or replacing) `project_settings.config`. */
export async function copyThreeMfWithProjectSettings(inputPath: string, outputPath: string, projectSettings: string): Promise<void> {
  const sourceZip = await openZip(inputPath)
  const outputZip = new yazl.ZipFile()
  const output = createWriteStream(outputPath)
  outputZip.outputStream.pipe(output)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      sourceZip.close()
      if (error) { output.destroy(); reject(error) } else { resolve() }
    }
    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('close', () => finish())
    sourceZip.on('error', finish)
    sourceZip.on('end', () => {
      outputZip.addBuffer(Buffer.from(projectSettings, 'utf8'), PROJECT_SETTINGS_ENTRY)
      outputZip.end()
    })
    sourceZip.on('entry', (entry: Entry) => {
      if (/\/$/.test(entry.fileName)) {
        outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
        sourceZip.readEntry()
        return
      }
      // Skip any existing project_settings entry; we add our own after all entries.
      if (entry.fileName === PROJECT_SETTINGS_ENTRY) { sourceZip.readEntry(); return }
      readZipEntryBuffer(sourceZip, entry).then(
        (buffer) => { outputZip.addBuffer(buffer, entry.fileName, { mtime: entry.getLastModDate() }); sourceZip.readEntry() },
        finish
      )
    })
    sourceZip.readEntry()
  })
}

/**
 * If `inputPath` lacks a structurally complete `project_settings.config`, synthesize one from the
 * slice's own profile args (via {@link exportMergedProjectSettings}), overlay whatever partial
 * settings the 3MF DID embed (so the project's `curr_bed_type`, filament colours, and retargeted
 * machine identity win over the export's values), and return the path to a rewritten 3MF that
 * embeds the merge. Returns `inputPath` unchanged when it already embeds a complete config, or
 * when synthesis fails (best-effort — the slice then proceeds and surfaces its own error rather
 * than this masking it).
 */
export async function ensureEmbeddedProjectSettings(input: {
  inputPath: string
  cliPath: string
  appDir: string | null
  profileArgs: readonly string[]
  /** The slicer target's flattened builtin profile catalog (machine_full/ etc.), when available. */
  profileDir?: string | null
  workDir: string
  env: NodeJS.ProcessEnv
  log: (message: string) => void
  signal?: AbortSignal
}): Promise<string> {
  const embedded = await readEmbeddedProjectSettings(input.inputPath)
  if (embedded !== null && COMPLETE_SETTINGS_SENTINEL_KEYS.every((key) => embedded[key] !== undefined)) {
    return input.inputPath
  }

  // Args the settings export runs with. Normally the slice's own profile args; a PROJECT-PRESET
  // slice loads none (the embedded settings ARE the preset), so derive them from the preset names
  // the embedded settings carry — the case that used to be skipped outright and let a partial
  // config reach the loader bare (deterministic SIGSEGV at "Start to load files").
  let exportArgs: readonly string[] = input.profileArgs
  const hasLoadSettings = exportArgs.includes('--load-settings') || exportArgs.includes('--load-filaments')
  if (!hasLoadSettings) {
    const derived = embedded !== null && input.profileDir
      ? await buildExportArgsFromEmbeddedPresetNames(embedded, input.profileDir)
      : null
    if (!derived) {
      // Nothing to synthesize from (no embedded settings to name presets, or none resolved).
      // Slicing proceeds as-is; if the config is partial the CLI may crash at load, so leave a
      // trace for that diagnosis.
      if (embedded !== null) {
        input.log('Embedded project settings are incomplete and name no resolvable presets; slicing as-is')
      }
      return input.inputPath
    }
    exportArgs = derived
  }
  exportArgs = await ensureFilamentCoverage(exportArgs, input.profileDir)

  input.log(embedded === null
    ? 'Synthesizing project settings for scaffold 3MF (no embedded project_settings.config)'
    : 'Completing partial embedded project settings for scaffold 3MF')
  const projectSettings = await exportMergedProjectSettings({
    cliPath: input.cliPath,
    appDir: input.appDir,
    profileArgs: exportArgs,
    workDir: input.workDir,
    env: input.env,
    signal: input.signal
  })
  if (!projectSettings) {
    input.log('Could not export merged project settings; slicing the scaffold 3MF as-is')
    return input.inputPath
  }
  let embeddableSettings = projectSettings
  if (embedded !== null) {
    try {
      embeddableSettings = JSON.stringify({ ...JSON.parse(projectSettings) as Record<string, unknown>, ...embedded })
    } catch {
      // Unparseable export: embed it verbatim; it is still structurally complete for the loader.
    }
  }
  const rewrittenPath = path.join(input.workDir, 'input.with-project-settings.3mf')
  await copyThreeMfWithProjectSettings(input.inputPath, rewrittenPath, embeddableSettings)
  return rewrittenPath
}
